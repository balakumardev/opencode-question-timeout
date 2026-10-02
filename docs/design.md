# Design: timing out unanswered questions

This plugin updates only OpenCode V2's built-in `question` tool. Its Effect-native `Plugin.define` setup uses `ctx.tool.transform` to wrap the tool's existing executor with `Effect.timeoutOption`. The original executor runs in the same request Effect context, so normal answers and ordinary errors retain their original behavior.

That request context matters to the TUI: a previous Promise-based adapter lost the ambient request location on `form.created`. The TUI could show “Asked 1 question” without displaying the choices. Composing the timeout inside the Effect instead preserves the location needed to deliver the form to the client.

If the deadline expires, the waiting question Effect is interrupted and its form is canceled. The returned result contains one empty answer array per question, `metadata.timedOut: true`, and agent-visible text stating that the user may be away and did **not** approve anything. An answer after cancellation cannot retroactively complete the form. A timely answer passes through unchanged; explicit dismissal and session interruption are not reclassified as timeouts.

Permission prompts are separate from questions and are not wrapped. The timeout message permits only safe, reversible assumptions; if an action needs explicit approval, the agent must stop and report that blocker instead of inferring consent from silence.
