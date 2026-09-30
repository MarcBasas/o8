# o8 plugin package and submission

This is the local package preparation for [#2952](https://github.com/hurttlocker/o8/issues/2952).
It does not establish directory acceptance, public availability, or hosted access.

## Package scope

[`plugins/o8/plugin.json`](../../plugins/o8/plugin.json) uses the portable Agent
Plugins format with two skills: local status and durable task handoff. Its
resources and icon are packaged together. The repository marketplace at
[`.agents/plugins/marketplace.json`](../../.agents/plugins/marketplace.json)
makes the package available for local testing without requiring installation
or changing a user's enabled plugins.

The skills are restricted to the Codex product and require local shell access,
the installed o8 CLI, a running app, and an authenticated agent runtime for new
work. They do not provide a hosted MCP endpoint for ChatGPT web or mobile.
The plugin package version is separate from the desktop app version.

## Decide the first public scope before uploading

The [current submission flow](https://developers.openai.com/plugins/deploy/submission)
accepts skills, MCP connections, or both. It does not currently support adding
an MCP server to an existing skills-only plugin. A plugin with a server must
include that server in its initial ZIP. Its URL also cannot be changed through
the ordinary update flow.

Therefore, this local package is a review candidate. Before the first public
submission, the publisher must choose whether to submit it as a permanently
separate local workflow listing or prepare the hosted connection in the initial
o8 listing. Do not upload a guessed endpoint, expose the local operator API,
or imply that local instructions provide remote access.

For the hosted route, retain #2952's scoped plugin principal, account
authorization, audit attribution, and operator approval boundaries. That route
requires a public HTTPS endpoint and the applicable MCP review materials,
including a test account when sign-in is required, five positive cases, three
negative cases, and a recorded walkthrough. Status events remain separate in
[#2953](https://github.com/hurttlocker/o8/issues/2953).

## Prepare the archive

From the repository root, create a ZIP containing only the package directory:

```sh
python3 -m zipfile -c /tmp/o8-plugin.zip plugins/o8
python3 -m zipfile -l /tmp/o8-plugin.zip
```

The single top-level `o8/` directory contains `plugin.json`, `assets/`, and
`skills/`. Do not archive the repository, runtime configuration, credentials,
task briefs, source logs, or dependency directories.

Check the manifest's required listing fields, their current submission limits,
all referenced files, the square icon dimensions, and skill frontmatter against
the [submission field reference](https://developers.openai.com/plugins/deploy/submission#automatically-provide-submission-and-review-information)
and [error reference](https://developers.openai.com/plugins/deploy/submission-errors).
The portal's validation and skill scans remain authoritative.

## Verify the workflows

1. Install the package from the repository marketplace in a disposable local
   test environment. Confirm it appears in the desktop Plugins view and CLI
   `/plugins`; source files alone do not prove host loading.
2. In a new local task, ask: "Check o8 and tell me what needs my attention."
   Compare the answer with `o8 status --json` and the running app. Confirm that
   no approvals, settings, or processes changed.
3. On a disposable repository, supply explicit backend, model, and effort and
   request a bounded task. Confirm one persisted lead, a task-specific brief,
   an admission receipt, and a visible entry in o8.
4. Send a follow-up and retry the same message with the same idempotency key.
   Confirm the retry does not create a second turn. Reattach using the saved
   turn and cursor. Confirm the answer distinguishes acceptance from completion.
5. Test a missing CLI, unreachable app, unavailable local execution, ambiguous
   task ID, and missing routing. Confirm the skill reports the boundary rather
   than guessing, installing software, or changing account configuration.

The deterministic `node scripts/verify-lead-handoff.mjs` probe covers the real
CLI, route, persistence, replay, wait, and stop contracts without a model API.
It supports the command contract but does not replace plugin-host and native
app testing. Run the existing managed-run real-path tests if exercising the
optional visible-command workflow.

The `o8 mcp install --codex` installer in #2952 is a separate unimplemented
acceptance item; these skills use the existing CLI and do not require it.

## Listing and publisher checks

The package uses the product name `o8` and the subtitle "Direct your coding
agents". Its prompts describe status, scoped work, and follow-ups. They make
no placement, recommendation, pricing, or endorsement claims.

Before review:

- Confirm the organization, project, publishing role, and verified developer
  identity. The dashboard sets the public publisher name from that identity.
- Confirm the website, support, privacy, and terms URLs identify the same
  publisher and are publicly accessible.
- Review the published privacy policy for this plugin's actual data flow.
  Instructions run in the host; local CLI calls reach o8, and authorized briefs
  may reach the selected agent provider. A hosted connector would introduce
  additional processing that needs its own accurate disclosure.
- Confirm the local workflows are eligible for the Directory. The guidelines
  allow additional eligibility requirements for skills-only listings.
- Confirm users receive working product functionality rather than an
  advertising-only workflow. Use only the capabilities and evidence verified
  in the installed build.

## Upload, review, and publication

After the scope and publisher checks, open the [Plugins dashboard](https://platform.openai.com/plugins)
and choose **Upload new or existing plugin**. Upload the reviewed ZIP under the
verified identity. Resolve metadata and skill findings, and finish MCP setup
if a server is included. Preserve the scan findings and resulting draft ID.

Submitting review requires the publisher's policy attestations. Public
publication is a separate action after approval. Record the draft, review
outcome, and published listing URL separately; an uploaded ZIP does not mean
the plugin is listed. Keep #2952 open until its actual acceptance conditions
are met.

## Official references

- [Package format](https://developers.openai.com/plugins/build/plugins)
- [Skill requirements](https://developers.openai.com/plugins/build/skills)
- [Submission and publication](https://developers.openai.com/plugins/deploy/submission)
- [Plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines)
- [Submission errors](https://developers.openai.com/plugins/deploy/submission-errors)
