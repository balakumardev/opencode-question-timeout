import { Plugin } from "@opencode/plugin/effect";
import { Duration, Effect, Option, Schema } from "effect";

// Configure timeoutMs, allowBlockers, and continueOnTimeout through plugin options.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

function withBlockerInput(input) {
  const questions = input?.fields?.questions;
  const question = questions?.value;
  if (typeof input?.mapFields !== "function" || typeof question?.mapFields !== "function" ||
      typeof question.fields?.multiple?.annotate !== "function") {
    throw new Error("Cannot enable allowBlockers: unsupported question input schema");
  }

  const markedQuestion = question.mapFields((fields) => ({
    ...fields,
    // Reuse the host's optional boolean; separate Effect copies have different parser sentinels.
    blocker: question.fields.multiple.annotate({
      description: "Set true only when an answer is required before work can continue. A blocker has no timeout; the whole batch waits for a response.",
    }),
  }), { unsafePreserveChecks: true }).annotate(question.ast.annotations ?? {});

  // Adding an optional field must preserve the native validation and descriptions.
  let markedQuestions = Schema.Array(markedQuestion).annotate(questions.ast.annotations ?? {});
  if (questions.ast.checks?.length) markedQuestions = markedQuestions.check(...questions.ast.checks);

  return input.mapFields((fields) => ({ ...fields, questions: markedQuestions }), {
    unsafePreserveChecks: true,
  }).annotate(input.ast.annotations ?? {});
}

export default Plugin.define({
  id: "question-timeout",
  effect: (ctx) => Effect.gen(function* () {
    const {
      timeoutMs = DEFAULT_TIMEOUT_MS,
      allowBlockers = false,
      continueOnTimeout = true,
    } = ctx.options ?? {};
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new RangeError(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
    }
    for (const [name, value] of Object.entries({ allowBlockers, continueOnTimeout })) {
      if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
    }

    yield* ctx.tool.transform((editor) => {
      if (!editor.get("question")) throw new Error("Built-in question tool is unavailable; cannot install timeout");
      editor.update("question", (tool) => {
        const ask = tool.execute;
        tool.description += `\n\nUnanswered questions time out after ${timeoutMs} ms.`;
        if (allowBlockers) {
          tool.input = withBlockerInput(tool.input);
          tool.description += " Set blocker: true on a question only when its answer is required before work can continue. If any question is a blocker, the entire batch has no timeout.";
        }
        if (continueOnTimeout) {
          tool.description += " After a non-blocking question times out, continue with your recommended option and keep working. State any assumptions; a timeout is not user approval.";
        }

        tool.execute = (input, context) => {
          const blocker = allowBlockers && input.questions.some((question) => question.blocker === true);
          const nativeInput = allowBlockers ? {
            ...input,
            questions: input.questions.map(({ blocker, ...question }) => question),
          } : input;
          const answer = ask(nativeInput, context);
          if (blocker) return answer;

          return answer.pipe(
            Effect.timeoutOption(Duration.millis(timeoutMs)),
            Effect.map((result) => {
              if (Option.isSome(result)) return result.value;

              const answers = input.questions.map(() => []);
              return {
                output: { answers },
                metadata: { answers, timedOut: true },
                content:
                  `No user response within ${timeoutMs} ms; this question timed out. ` +
                  "The user may be away. This was not user approval. " +
                  (continueOnTimeout
                    ? "For non-blocking questions, continue with your recommended option and keep working without asking the same question again. " +
                      "If no option was recommended, choose a safe, reversible default and state your assumption. " +
                      "Do not stop just because the question timed out. If a required answer or explicit approval is genuinely missing, report that blocker."
                    : "Continue with safe, reversible assumptions without asking the same question again. " +
                      "If explicit approval is required, stop and report the blocker instead."),
              };
            }),
          );
        };
      });
    });
  }),
});
