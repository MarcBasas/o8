# ChatGPT plan sign-in development acceptance

This is the source acceptance record for the desktop text-chat increment of
[#2951](https://github.com/hurttlocker/o8/issues/2951). It is separate from the
[hosted plugin connection](./openai-plugin-submission.md). Source preparation
does not establish installed acceptance, OpenAI qualification, or publication.

## Behavior

Onboarding and Settings > Models offer **Continue with ChatGPT** after the user
signs in to o8. The local broker uses the open-source loopback OIDC flow with
PKCE, state, nonce and an opaque installation identifier. It retains the issued
client registration across retries and restarts. Identity and plan-use scope
are checked separately. Email labels do not merge accounts.

The initial secure-store implementation supports macOS. Other platforms fail
closed. OpenAI tokens remain in the OS Keychain; the renderer receives connection
metadata and account-available model names. Refresh is serialized across
processes, and an uncertain rotation is held rather than replayed. Disconnect
clears local access before requesting issuer revocation and reports an
unconfirmed remote result.

Selecting a ChatGPT model uses the Responses transport with `stream: true` and
`store: false`. It advertises only o8's local function tools, with a registered
repository required for tools. Repository policy and exact operator approvals
remain authoritative. A turn and its persisted approvals retain their original
desktop session, selected registration and grant generation. Switching accounts
away and back cannot resume the old turn.

The selected route stays visible in the composer. Saved conversations retain
that route when discovery fails. Plan turns stop on caps, auth errors, incomplete
streams or unsupported requests. They do not automatically retry or move to
API billing. Automatic follow-up inference and compaction are disabled for this
route. Successful messages retain subscription-route metadata; token counts do
not establish allowance savings or an API price.

## Source evidence

- [Entry-point tests](../../src/lib/chatgpt-plan/plan-entry.test.ts) call the
  exported connection, inference and approval handlers against a signed stub
  OIDC provider, streamed Responses fixture and persisted state. They cover
  fresh profiles without CLIs, restart, scope denial, replay, account switches,
  refresh uncertainty, issuer revocation refusal, approved edits and interrupted
  continuations. A separate-process fixture proves serialized rotating refresh.
- [Mounted UI tests](../../src/components/desktop/settings/ChatGPTPlanConnection.test.ts)
  cover retained registration retry, Disconnect visibility during provider
  failure, and saved-model restoration without selecting another provider.
- [Streaming tests](../../src/components/desktop/llm-chat/streaming-plan.test.ts)
  cover split frames, explicit completion, malformed data, usage metadata and
  absence of extra automatic inference.
- [Opt-in native credential test](../../src/lib/chatgpt-plan/native-keychain.test.ts)
  verifies a large synthetic record through the real macOS Keychain, including
  replacement and a cold read. The test creates and removes only its own entries.

## Remaining acceptance

- OpenAI qualification for o8's intended open-source distribution before release.
- Actual consent and first inference in an installed desktop, natural refresh,
  remote revoke, account switching and interrupted-stream behavior.
- Equivalent OS credential stores on supported non-macOS platforms.
- Explicit integration with the orchestrator API lead and Symon text work.
- Hosted worker creation under a separate grant, tracked in
  [#3249](https://github.com/hurttlocker/o8/issues/3249), and an installed
  ChatGPT-to-worker round trip on a disposable repository.
- The attributable planning/execution allowance experiment in
  [the usage protocol](./chatgpt-plugin-usage.md).

See the [account and consent contract](./openai-account-consent.md) for the
identity, payer and recipient boundaries. Sign-in adds no subscription allowance
and grants no access to ChatGPT conversations or memories.

## Profile credential isolation

The macOS broker binds each Keychain index and chunk to the stable local host ID
and o8 account. Independently initialized profiles cannot read or replace each
other's credentials. Profiles copied with the same host ID retain the same
credential identity and share one OS-user rotation lock, even under different
profile paths. Owner-only records from earlier unpublished development are not
automatically adopted; the operator must authenticate again.

The actual Keychain synthetic fixture verifies independent read/replacement,
cold reopening, copied-host lock exclusion and cleanup. It grants no live OpenAI
access and does not establish installed OAuth or provider inference acceptance.
