import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Context, Deferred, Duration, Effect, Exit, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";

const questions = {
  questions: [
    {
      question: "Which option should I use?",
      header: "Option",
      options: [{ label: "Alpha", description: "First choice" }],
    },
    {
      question: "Anything else?",
      header: "Notes",
      options: [],
      multiple: true,
    },
  ],
};

const toolContext = {
  sessionID: "ses_question_timeout_test",
  agent: "build",
  messageID: "msg_question_timeout_test",
  id: "call_question_timeout_test",
  progress: () => Effect.void,
};

async function loadPlugin() {
  const plugin = (await import("../index.js")).default;
  assert.equal(typeof plugin.effect, "function", "the question wrapper must run in the original Effect context");
  return plugin;
}

function testHost(original, options = {}) {
  const tool = { name: "question", options: { codemode: false }, execute: original };
  let execute;
  return {
    context: {
      options,
      tool: {
        transform: (change) => Effect.sync(() => {
          change({
            get: (id) => id === "question" ? tool : undefined,
            update: (id, update) => {
              assert.equal(id, "question");
              update(tool);
              execute = tool.execute;
            },
          });
          return { dispose: Effect.void };
        }),
      },
    },
    execute: () => {
      assert.equal(typeof execute, "function", "the built-in question tool must be wrapped");
      return execute;
    },
  };
}

async function questionExecutor(original, options = {}) {
  const plugin = await loadPlugin();
  const host = testHost(original, options);
  await Effect.runPromise(plugin.effect(host.context));
  return host.execute();
}

class TestLocation extends Context.Service()("@test/QuestionLocation") {}

test("agent-initiated forms retain ambient location for client delivery", async () => {
  let published;
  const execute = await questionExecutor(() =>
    Effect.serviceOption(TestLocation).pipe(
      Effect.map((location) => {
        published = {
          type: "form.created",
          ...(Option.isSome(location) ? { location: location.value } : {}),
        };
        return { output: { answers: [["Alpha"], []] }, content: "answered" };
      }),
    ),
  );

  await Effect.runPromise(
    execute(questions, toolContext).pipe(Effect.provideService(TestLocation, { directory: "/workspace" })),
  );

  assert.deepEqual(published, { type: "form.created", location: { directory: "/workspace" } });
});

test("an unanswered question interrupts its form after the default five minutes", async () => {
  let cancelled = false;
  const execute = await questionExecutor(() =>
    Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { cancelled = true; }))),
  );

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* execute(questions, toolContext).pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(299_999));
      assert.equal(cancelled, false);
      yield* TestClock.adjust(Duration.millis(1));
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  assert.equal(cancelled, true);
  assert.deepEqual(result.output, { answers: [[], []] });
  assert.equal(result.metadata?.timedOut, true);
  assert.match(result.content, /timed out/i);
  assert.match(result.content, /may be away/i);
  assert.match(result.content, /not user approval/i);
});

test("timeoutMs overrides the default and updates the agent-facing result", async () => {
  let cancelled = false;
  const execute = await questionExecutor(
    () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { cancelled = true; }))),
    { timeoutMs: 2_000 },
  );

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* execute(questions, toolContext).pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(1_999));
      assert.equal(cancelled, false);
      yield* TestClock.adjust(Duration.millis(1));
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  assert.equal(cancelled, true);
  assert.deepEqual(result.output, { answers: [[], []] });
  assert.equal(result.metadata?.timedOut, true);
  assert.match(result.content, /2000 ms/);
  assert.doesNotMatch(result.content, /5 minutes/i);
});

test("one unanswered question produces one empty answer", async () => {
  const execute = await questionExecutor(() => Effect.never, { timeoutMs: 2 });
  const input = { questions: [questions.questions[0]] };
  const result = await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* execute(input, toolContext).pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.millis(2));
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer())));
  assert.deepEqual(result.output, { answers: [[]] });
  assert.equal(result.metadata.timedOut, true);
});

test("an answer one millisecond before timeout wins", async () => {
  const gate = await Effect.runPromise(Deferred.make());
  const answer = { output: { answers: [["Alpha"], []] }, content: "answered" };
  const execute = await questionExecutor(() => Deferred.await(gate), { timeoutMs: 2_000 });
  const result = await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* execute(questions, toolContext).pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.millis(1_999));
    yield* Deferred.succeed(gate, answer);
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer())));
  assert.strictEqual(result, answer);
});

test("a timely answer is returned unchanged", async () => {
  const answer = {
    output: { answers: [["Alpha"], []] },
    content: "User has answered your questions",
    metadata: { answers: [["Alpha"], []] },
  };
  const execute = await questionExecutor(() => Effect.succeed(answer));

  assert.strictEqual(await Effect.runPromise(execute(questions, toolContext)), answer);
});

test("dismissing a question remains a defect, not a timeout answer", async () => {
  const dismissed = new Error("The user dismissed this question");
  const execute = await questionExecutor(() => Effect.die(dismissed));

  const exit = await Effect.runPromiseExit(execute(questions, toolContext));

  assert.equal(Exit.isFailure(exit), true);
  assert.strictEqual(Cause.squash(exit.cause), dismissed);
});

test("interrupting the session does not manufacture a timeout answer", async () => {
  const execute = await questionExecutor(() => Effect.never);

  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* execute(questions, toolContext).pipe(Effect.forkChild);
      yield* Fiber.interrupt(fiber);
      return yield* Fiber.await(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  assert.equal(Exit.isFailure(exit), true);
  assert.equal(Cause.hasInterrupts(exit.cause), true);
});

test("a missing built-in question tool fails registration", async () => {
  const plugin = await loadPlugin();

  await assert.rejects(
    Effect.runPromise(plugin.effect({
      options: {},
      tool: { transform: (change) => Effect.sync(() => change({ get: () => undefined, update: () => {} })) },
    })),
    /question tool/i,
  );
});

test("invalid timeoutMs values fail at plugin setup", async () => {
  const plugin = await loadPlugin();

  for (const value of [0, -1, 1.5, "300000", null, Infinity, 2_147_483_648]) {
    await assert.rejects(
      Effect.runPromise(plugin.effect({
        options: { timeoutMs: value },
        tool: { transform: () => Effect.void },
      })),
      /timeoutMs/,
      `timeoutMs=${String(value)}`,
    );
  }
});
