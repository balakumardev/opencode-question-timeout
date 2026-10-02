# OpenCode Question Timeout

An OpenCode V2 plugin that lets the built-in `question` tool time out when the user does not respond. The pending question is canceled, and the agent receives an explicit timeout result—not an answer or user approval.

**Compatibility:** Tested with OpenCode V2.0.18 only. Compatibility with other versions is unverified. Version `v0.1.0` is distributed through GitHub, not the npm registry.

## Install

```sh
opencode plugin add 'github:balakumardev/opencode-question-timeout#v0.1.0'
```

By default, an unanswered question times out after five minutes (`300000` ms).

## Configure the timeout

To use a different deadline, **replace** the package entry installed by the CLI in your OpenCode `opencode.json(c)` `plugins` array with this object form. Do not append a second copy of the same plugin.

```jsonc
{
  "plugins": [
    {
      "package": "github:balakumardev/opencode-question-timeout#v0.1.0",
      "options": { "timeoutMs": 600000 }
    }
  ]
}
```

This example waits ten minutes. `timeoutMs` must be an integer from `1` through `2147483647` milliseconds, inclusive. Invalid values (including zero, `null`, fractions, and values above the maximum) fail plugin setup.

## What a timeout means

- A timely answer is returned unchanged. When the deadline expires, the pending question is canceled and the agent gets an empty answer for each question plus `metadata.timedOut: true` and text stating that the user may be away and **did not approve anything**.
- An answer submitted after the question has timed out cannot retroactively answer that canceled form; the user can clarify in a new message. A dismissed question or interrupted session is not converted into a timeout result.
- This plugin changes the built-in `question` tool, **not permission prompts**. A timeout is never approval: the agent may continue with safe, reversible assumptions, but must stop and report a blocker for actions that require explicit approval.

## Local development

Use Node.js **22.19.0 or newer** to install and test locally. The pinned dependency tree includes a transitive package whose engine requires Node.js `>=22.19.0`. CI installs a current Node.js 22 patch release.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```
