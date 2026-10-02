import { Plugin } from "@opencode/plugin/effect";
import { Duration, Effect, Option } from "effect";

// Configurable through plugins: [{ package: "./plugins/question-timeout", options: { timeoutMs: 300000 } }].
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export default Plugin.define({
  id: "question-timeout",
  effect: (ctx) => Effect.gen(function* () {
    const configured = ctx.options?.timeoutMs;
    const timeoutMs = configured === undefined ? DEFAULT_TIMEOUT_MS : configured;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new RangeError(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
    }

    yield* ctx.tool.transform((editor) => {
      if (!editor.get("question")) throw new Error("Built-in question tool is unavailable; cannot install timeout");
      editor.update("question", (tool) => {
        const ask = tool.execute;

        tool.execute = (input, context) => ask(input, context).pipe(
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
                "Continue with safe, reversible assumptions without asking the same question again. " +
                "If explicit approval is required, stop and report the blocker instead.",
            };
          }),
        );
      });
    });
  }),
});
