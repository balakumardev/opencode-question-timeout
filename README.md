# OpenCode Question Timeout

An OpenCode V2 plugin that lets the built-in `question` tool time out when the user does not respond. By default, the timeout tells the agent to continue with its recommended option. Optionally, let the model mark blocking questions that must wait for an answer.

**Compatibility:** Tested with OpenCode V2.0.18 only. Compatibility with other versions is unverified. Version `v0.2.0` is distributed through GitHub, not the npm registry.

## Install

```sh
opencode plugin add 'github:balakumardev/opencode-question-timeout#v0.2.0'
```

By default, an unanswered question times out after five minutes (`300000` ms). A timeout is never an answer or user approval.

## Configuration

To configure the plugin, **replace** the package entry installed by the CLI in your OpenCode `opencode.json(c)` `plugins` array with this object form. Do not append a second copy of the same plugin. The `allowBlockers` and `continueOnTimeout` options require `v0.2.0` or later.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:balakumardev/opencode-question-timeout#v0.2.0",
      "options": {
        "timeoutMs": 600000,
        "allowBlockers": true,
        "continueOnTimeout": true
      }
    }
  ]
}
```

This example waits ten minutes for ordinary questions and enables blocker declarations.

| Option | Default | Behavior |
| --- | --- | --- |
| `timeoutMs` | `300000` | Deadline in milliseconds for unanswered questions. |
| `allowBlockers` | `false` | Exposes an optional per-question `blocker` boolean to the model. A question with `blocker: true` has no timeout. |
| `continueOnTimeout` | `true` | Tells the agent to continue with its recommended option after a non-blocking question times out. Set to `false` to restore the previous generic timeout guidance. |

`timeoutMs` must be an integer from `1` through `2147483647` milliseconds, inclusive. The other options must be booleans. Invalid values (including `null` and strings such as `"false"`) fail plugin setup.

### Blocking questions

With `allowBlockers: true`, the plugin teaches the model to set `blocker: true` inside a `questions` entry only when an answer is required before work can continue. Omitting it or using `false` keeps the normal timeout. With the feature off, blocker declarations do not disable timeouts.

A batch shares one form: **if any question is a blocker, the entire batch waits indefinitely**, regardless of `continueOnTimeout`. The user can still answer or dismiss the form, or interrupt the session. The model should ask unrelated non-blocking questions separately if they should have their own deadline.

## What a timeout means

- A timely answer is returned unchanged. When the deadline expires, the pending question is canceled and the agent gets an empty answer for each question plus `metadata.timedOut: true` and text stating that the user may be away and **did not approve anything**.
- With `continueOnTimeout: true`, that text explicitly asks the agent to continue with its recommended option, keep working, and avoid repeating the same question. If no option was recommended, it asks the agent to choose a safe, reversible default and state the assumption. This is guidance to the agent; the plugin does not select an answer on the user's behalf.
- With `continueOnTimeout: false`, the previous guidance is used: continue only with safe, reversible assumptions, and report a blocker if explicit approval is required.
- An answer submitted after the question has timed out cannot retroactively answer that canceled form; the user can clarify in a new message. A dismissed question or interrupted session is not converted into a timeout result.
- This plugin changes the built-in `question` tool, **not permission prompts**. Required answers and explicit approvals cannot be inferred from a timeout.

## Local development

Use Node.js **22.19.0 or newer** to install and test locally. The pinned dependency tree includes a transitive package whose engine requires Node.js `>=22.19.0`. CI installs a current Node.js 22 patch release.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```
