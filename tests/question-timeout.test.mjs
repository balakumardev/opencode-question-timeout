import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Cause, Context, Deferred, Duration, Effect, Exit, Fiber, Option, Schema } from "effect";
import { TestClock } from "effect/testing";

// The built-in question tool's Effect schema, including its non-empty batch constraint.
function questionInputSchema(schema) {
  return schema.Struct({
    questions: schema.Array(schema.Struct({
      question: schema.String,
      header: schema.String,
      options: schema.Array(schema.Struct({ label: schema.String, description: schema.String })),
      multiple: schema.optionalKey(schema.Boolean),
    }).annotate({ identifier: "Question.Prompt" }))
      .check(schema.isNonEmpty())
      .annotate({ description: "Questions to ask" }),
  });
}

const questionInput = questionInputSchema(Schema);

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

function testHost(original, options = {}, input = questionInput) {
  const tool = {
    name: "question",
    description: "Ask the user questions. Mark the preferred option (Recommended).",
    input,
    output: Schema.Struct({ answers: Schema.Array(Schema.Array(Schema.String)) }),
    options: { codemode: false },
    execute: original,
  };
  let execute;
  return {
    tool,
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
  assert.match(result.content, /continue with (?:your|the) recommended option/i);
  assert.match(result.content, /without asking the same question again/i);
});

test("continueOnTimeout can restore the previous timeout guidance", async () => {
  const execute = await questionExecutor(() => Effect.never, { timeoutMs: 2, continueOnTimeout: false });
  const result = await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* execute(questions, toolContext).pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.millis(2));
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer())));

  assert.deepEqual(result.output, { answers: [[], []] });
  assert.equal(result.metadata.timedOut, true);
  assert.match(result.content, /not user approval/i);
  assert.match(result.content, /safe, reversible assumptions/i);
  assert.doesNotMatch(result.content, /recommended option/i);
});

test("blocker input is advertised and validated only when enabled", async () => {
  const plugin = await loadPlugin();
  for (const options of [{}, { allowBlockers: false }]) {
    const host = testHost(() => Effect.never, options);
    await Effect.runPromise(plugin.effect(host.context));
    assert.strictEqual(host.tool.input, questionInput);
    assert.doesNotMatch(host.tool.description, /blocker: true/i);
  }

  const host = testHost(() => Effect.never, { allowBlockers: true });
  await Effect.runPromise(plugin.effect(host.context));
  const decode = Schema.decodeUnknownSync(host.tool.input);
  const input = { questions: [{ ...questions.questions[0], blocker: true }] };
  assert.deepEqual(decode(input), input, "the blocker flag must survive input decoding");
  assert.deepEqual(decode(questions), questions, "ordinary questions must still validate");
  assert.match(host.tool.description, /blocker: true/i);
  assert.match(host.tool.description, /no timeout/i);
  assert.match(JSON.stringify(Schema.toJsonSchemaDocument(host.tool.input)), /"blocker"/);
  assert.throws(() => decode({ questions: [] }), "the native non-empty constraint must be preserved");
  assert.throws(() => decode({ questions: [{ ...questions.questions[0], blocker: "true" }] }));
  assert.throws(() => decode({ questions: [{ header: "Missing question", options: [] }] }));
  assert.equal(questionInput.fields.questions.value.fields.blocker, undefined, "the original schema must not be mutated");
});

test("blockers survive decoding when OpenCode and the plugin load separate Effect copies", async (t) => {
  const tempRoot = join(tmpdir(), "opencode");
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, "question-timeout-effect-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const effectRoot = dirname(dirname(fileURLToPath(import.meta.resolve("effect"))));
  const hostEffect = join(directory, "effect");
  await cp(join(effectRoot, "dist"), join(hostEffect, "dist"), { recursive: true });
  await cp(join(effectRoot, "package.json"), join(hostEffect, "package.json"));
  await symlink(dirname(effectRoot), join(directory, "node_modules"), "dir");
  const hostSchema = await import(pathToFileURL(join(hostEffect, "dist/Schema.js")).href);

  const plugin = await loadPlugin();
  const gate = await Effect.runPromise(Deferred.make());
  const host = testHost(() => Deferred.await(gate), { timeoutMs: 2, allowBlockers: true }, questionInputSchema(hostSchema));
  await Effect.runPromise(plugin.effect(host.context));
  const decode = hostSchema.decodeUnknownSync(host.tool.input);
  const input = { questions: [{ ...questions.questions[0], blocker: true }] };
  const decoded = decode(input);
  assert.deepEqual(decoded, input, "the host must decode blocker as true, not a foreign parser sentinel");
  assert.deepEqual(decode(questions), questions);
  assert.equal(decode({ questions: [{ ...questions.questions[0], blocker: false }] }).questions[0].blocker, false);
  assert.throws(() => decode({ questions: [{ ...questions.questions[0], blocker: "true" }] }));

  const answer = { output: { answers: [["Alpha"]] }, content: "answered" };
  const result = await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* host.execute()(decoded, toolContext).pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.millis(100));
    assert.equal(fiber.pollUnsafe(), undefined);
    yield* Deferred.succeed(gate, answer);
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer())));
  assert.strictEqual(result, answer);
});

for (const continueOnTimeout of [true, false]) {
  test(`a blocker keeps its whole batch waiting when continueOnTimeout=${continueOnTimeout}`, async () => {
    const gate = await Effect.runPromise(Deferred.make());
    let cancelled = false;
    let receivedInput;
    const answer = { output: { answers: [["Alpha"], ["Ready"]] }, content: "answered" };
    const execute = await questionExecutor((input) => {
      receivedInput = input;
      return Deferred.await(gate).pipe(Effect.onInterrupt(() => Effect.sync(() => { cancelled = true; })));
    }, { timeoutMs: 2_000, allowBlockers: true, continueOnTimeout });
    const input = {
      questions: [questions.questions[0], { ...questions.questions[1], blocker: true }],
    };

    const result = await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* execute(input, toolContext).pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(600_000));
      assert.equal(cancelled, false, "a blocker must not be cancelled by the deadline");
      assert.equal(fiber.pollUnsafe(), undefined);
      yield* Deferred.succeed(gate, answer);
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())));

    assert.strictEqual(result, answer);
    assert.deepEqual(receivedInput, questions, "plugin-only fields must not leak to the built-in executor");
    assert.equal(input.questions[1].blocker, true, "the caller's input must not be mutated");
  });
}

test("blocker declarations still time out when allowBlockers is off", async () => {
  for (const options of [{}, { allowBlockers: false }]) {
    const execute = await questionExecutor(() => Effect.never, { timeoutMs: 2, ...options });
    const input = { questions: [{ ...questions.questions[0], blocker: true }] };
    const result = await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* execute(input, toolContext).pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(2));
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())));

    assert.deepEqual(result.output, { answers: [[]] });
    assert.equal(result.metadata.timedOut, true);
  }
});

test("enabling blockers still times out ordinary questions", async () => {
  for (const extra of [{}, { blocker: false }]) {
    const execute = await questionExecutor(() => Effect.never, { timeoutMs: 2, allowBlockers: true });
    const input = { questions: [{ ...questions.questions[0], ...extra }] };
    const result = await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* execute(input, toolContext).pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(2));
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())));

    assert.deepEqual(result.output, { answers: [[]] });
    assert.equal(result.metadata.timedOut, true);
    assert.match(result.content, /continue with (?:your|the) recommended option/i);
  }
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
  for (const allowBlockers of [false, true]) {
    const dismissed = new Error("The user dismissed this question");
    const execute = await questionExecutor(() => Effect.die(dismissed), { allowBlockers });
    const input = { questions: [{ ...questions.questions[0], blocker: true }] };

    const exit = await Effect.runPromiseExit(execute(input, toolContext));

    assert.equal(Exit.isFailure(exit), true);
    assert.strictEqual(Cause.squash(exit.cause), dismissed);
  }
});

test("interrupting the session does not manufacture a timeout answer", async () => {
  for (const allowBlockers of [false, true]) {
    const execute = await questionExecutor(() => Effect.never, { allowBlockers });
    const input = { questions: [{ ...questions.questions[0], blocker: true }] };

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* execute(input, toolContext).pipe(Effect.forkChild);
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    assert.equal(Exit.isFailure(exit), true);
    assert.equal(Cause.hasInterrupts(exit.cause), true);
  }
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

for (const option of ["allowBlockers", "continueOnTimeout"]) {
  test(`invalid ${option} values fail at plugin setup`, async () => {
    const plugin = await loadPlugin();

    for (const value of [null, 0, 1, "true", "false", [], {}]) {
      await assert.rejects(
        Effect.runPromise(plugin.effect(testHost(() => Effect.never, { [option]: value }).context)),
        new RegExp(option),
        `${option}=${JSON.stringify(value)}`,
      );
    }
  });
}
