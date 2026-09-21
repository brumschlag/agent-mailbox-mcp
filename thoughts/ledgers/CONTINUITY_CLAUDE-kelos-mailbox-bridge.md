# Continuity: Local↔kelos collaboration via MCP mailbox (human-in-the-loop)

**Started:** 2026-09-21. **Cluster:** `--context arn:aws:eks:us-east-1:565715328522:cluster/software-engineering`, ns `kelos-pilot`. ALWAYS `--context` per command (shared kubeconfig) — never `use-context`.

## Goal
The kelos **Task fleet** can **ask Brian a question mid-run and block for a real-time answer**, then resume. (Pattern C, applied to Tasks, not just Sessions.)

## Key Decisions
- Substrate: adopted `Kipachu-1/agent-mailbox-mcp` (★2, GO-WITH-FIXES security review), pinned upstream **`f54511da2911348dd587263beb25011dbbad7303`**, local clone `~/source/agent-mailbox-mcp`. NOT Buzz (too heavy for now).
- **beads = task source of truth; mailbox = coordination only** (locks/handoffs/presence/messages). Don't let mailbox tasks become a shadow backlog.
- Registry: **ECR** `565715328522.dkr.ecr.us-east-1.amazonaws.com/agent-mailbox-mcp` (same-account → node IAM pull, no imagePullSecret). Push requires the **`breakglass` profile** (TellihealthBedrockDeveloper is denied ECR); use `DOCKER_CONFIG=$(mktemp -d)` for the WSL cred-store bug.
- Pilot topology: ClusterIP + `kubectl port-forward` for local; kelos reaches via svc DNS. No ingress yet.
- Architecture **②: escalate-and-resume** — CHOSEN 2026-09-21 (user decision) over ① block-in-place. ① retired: two hard transport-layer walls (see RETIRED ① below). **Decisive fact (claude-code-guide, code.claude.com/docs/mcp):** MCP `notifications/progress` keepalives reset only the ~5min *idle* timer, NOT the **hard 120s wall-clock cap** per tool call; and auto-background fires only for *main-conversation* calls on v2.1.212+, so a **headless kelos Task's held call genuinely drops & loses its response at 120s**. => ① cannot span realistic human latency. ② has no held call, no SSE-delivery risk, no 120s cap.

## State
- Done:
  - [x] Security review (auth/hashing/SQL clean; beeai-framework 249-pkg tree is the residual supply-chain flag)
  - [x] Dockerfile fixes (`USER bun`, `PORT=8080`); amd64 build; pushed to ECR (`0.1.0-amd64`, digest sha256:6b1b0f31…)
  - [x] Relay deployed to kelos-pilot: PVC(auto-ebs-gp3)+Deployment+Service; `/health` ok, `/mcp` 401 (auth enforced), 2 bootstrap tokens
  - [x] AgentConfig `collab-bridge` (mcpServers http + cadence) + test Session `inpulse-collab` — proved BOTH planes online at once + message delivery
  - [x] Linchpin probe (Task `collab-probe-1`): Task→mailbox→human delivery WORKS; kelos does NOT reap a waiting Task
  - [x] Root-caused the socket-close: `watch_updates` is a **naive silent hold, no keepalive** → idle connection ECONNRESET at ~30-60s (reproduced with the reference SDK client, not just claude-code)
  - [x] Built `ask_human` (blocks + progress-notification keepalive); reviewed wiring; image `0.2.0-amd64` pushed to ECR + relay redeployed (tool live)
  - [x] Re-probe (Task `collab-probe-2`): **KEEPALIVE WORKS** — agent made ONE blocking `ask_human` call, connection survived to **120s** (heartbeats at 30/60/90/120s) vs the old 30-60s ECONNRESET. Guide's **2-min auto-background CONFIRMED**: claude-code 2.1.263 dropped the call at exactly 120s ("transport dropped mid-call; response lost") = `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` default 120000.
- Now: [→] **BUILD ② — the WATCHER (continuation trigger) is next.** Non-blocking tool DONE (below). See "② BUILD PLAN" under Next.

- RETIRED ① (kept for reuse — the mailbox reply-visibility facts still hold): TWO independent root causes localized (re-probe `collab-probe-3` on `0.3.0`, digest IDENTICAL to `0.2.0` — debugger only added tests, Dockerfile ships `src/` not `tests/`, so relay code UNCHANGED). Both were transport-layer, hence the pivot:

  **RULED OUT (proven this session):** matcher predicate is logically correct (`firstHumanReply` src/tools.ts:1202 = `id!=Q && sender!=asker && (recipient==asker || reply_to==Q)`); handler vars correct (src/tools.ts:456-473: workspace=agent.workspace=inpulse, questionId=question.id, threadId=question.thread_id, both=`01831307`); reply IS created correctly AND a **fresh** `get_thread(kelos, 01831307, inpulse)` RETURNS it (question + reply `ee74d621`, sender local-brian, recipient kelos, reply_to=Q). So NOT the predicate, NOT vars, NOT fresh-connection visibility.

  **CAUSE 1 — the long-poll handler never delivered the +60s reply (PRIMARY, unconfirmed hypothesis).** Reply landed at +60s; server had ~60s to detect before the drop; it didn't. Since a FRESH request sees the reply but the long-lived `ask_human` poll didn't, TWO candidate mechanisms to confirm next:
    - (B) **Stale read:** the long-lived handler's repeated `store.getThread` reuses a DB connection/transaction that snapshots BEFORE the concurrent reply write → never sees it. Check store connection/transaction handling (Bun SQLite / WAL / pooling); add a test that holds a poll loop while a SEPARATE connection writes a reply.
    - (C) **Response not flushed:** handler DID detect + `return json(...)` but the final tool result isn't flushed over the held SSE stream → client waits to its cap, reports "response lost". Add server-side logging of ask_human's return; inspect `WebStandardStreamableHTTPServerTransport` response delivery for a long call.
  - [ ] Confirm B vs C (server-side logging is the fastest discriminator), then fix.

  **CAUSE 2 — hard 120s client drop; my env var did NOT fix it.** Both probes dropped at EXACTLY 120s with "MCP transport dropped mid-call; response for tool ask_human was lost". `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=900000` was set on the pod and had NO effect → the guide's var name is WRONG or not honored (its whole timeout table is now suspect). Find the real knob (claude-code 2.1.263) or treat 120s as a hard ceiling.
  - [ ] Find the real 120s-cap control, OR design around it.

  **⭐ ARCHITECTURE RECONSIDER:** given TWO hard problems with the long-blocking call (delivery + 120s ceiling), **architecture ② (escalate-and-resume)** may be more robust than ① (block-in-place): Task posts question + EXITS (needs-human); human replies; a kelos trigger launches a continuation Task with the answer. No long holds, no SSE-delivery risk, no 120s cap. Reevaluate ① vs ② before sinking more into ①.
- Next — **② BUILD PLAN** (escalate-and-resume; design UNCONFIRMED until kelos trigger mechanism verified):
  - [x] **Continuation trigger DESIGN RESOLVED (linchpin verified 2026-09-21).** kelos v1alpha2 TaskSpawner `when` sources are ONLY `githubIssues`/`githubPullRequests`/`cron`/`jira` (skill `references/taskspawner.yaml`) — **NO generic webhook/gateway trigger**; pr-reviewer's `when.githubWebhook` is GitHub-shaped, not arbitrary-HTTP. So candidate (a) mailbox→kelos-webhook is DEAD. CHOSEN: a **watcher creates the continuation `Task` CRD directly** (kelos Task is a plain CRD; probe history proves on-demand `kubectl apply` works) — zero dependency on any kelos trigger feature. Watcher placement (sub-decision): **prototype with local `mb-client watch`** (Brian-in-loop, reversible), then optionally move into the relay w/ a ServiceAccount RBAC to create Tasks. NOTE: skill warns examples≠source; design deliberately avoids needing the `when` schema, so exact Go types need not be re-verified.
  - [x] **Non-blocking ask tool DONE 2026-09-21** — `ask_human_async` (`src/tools.ts`, right after retired `ask_human`): posts question, returns `{posted,question_id,thread_id,recipient_id}` instantly (no poll/keepalive/SSE hold). Task then exits. TDD'd: `tests/ask-human-async.test.ts` (3 tests) + full suite **83 pass/1 skip/0 fail, 0 regressions**. **WATCHER DATA CONTRACT** (metadata on the posted question): `event_type:"ask_human"`, `mode:"async"`, `recipient_id`, `asker_id` (=originating agent id, e.g. `kelos`), optional `resume_context` (where the run was), optional `continuation_task` (kelos resource to resume). Reply is readable via `getThread(asker_id, thread_id, workspace)` → firstHumanReply predicate (`sender!=asker && recipient==asker`).
  - [ ] **Answer-injection**: continuation Task must receive (original context/thread_id + the human's reply body). Decide carrier: mailbox `get_thread` at startup vs. injected env/prompt.
  - [ ] Local answerer already built: `scripts/mb-client.mjs answer <n>` (finds question, replies) + `getthread`.
  - [ ] Wire into a real TaskSpawner (candidate: `inpulse-pr-reviewer`) once the trigger loop is proven on a probe.
  - [ ] Reusable substrate already live & tested (82-pass): mailbox plumbing, `src/request-context.ts`, deploy manifests, ECR image, 2 planes online.

## Open Questions (UNCONFIRMED)
- UNCONFIRMED: do MCP progress notifications require a client-sent `progressToken`? If claude-code doesn't send one, need a transport-level SSE keepalive instead.
- UNCONFIRMED: exact claude-code MCP timeout env var names/defaults (guide's numbers unverified).

## Working Set
- Fork/clone: `~/source/agent-mailbox-mcp` @ upstream `f54511d` + **UNCOMMITTED** local changes (persist on disk, not in git history — consider committing first via `Skill("commit")`):
  - modified: `Dockerfile` (USER bun, PORT=8080), `src/mcp.ts` (ALS wiring), `src/tools.ts` (ask_human + firstHumanReply)
  - new: `src/request-context.ts`, `tests/ask-human.test.ts` (82-pass suite), `deploy/`, `scripts/`, `thoughts/`
- Manifests: `deploy/kelos-pilot/{relay.yaml(img 0.3.0),kelos-collab.yaml,probe-task.yaml(collab-probe-3+anti-cap env),APPLY.md}`
- Local client: `scripts/mb-client.mjs` — cmds: whoami/send/inbox/reply/watch/**answer**/**getthread**
- Tokens (mode 600): `~/.mailbox-local-token` (local-brian), `~/.mailbox-kelos-token` (kelos)
- ECR: `565715328522.dkr.ecr.us-east-1.amazonaws.com/agent-mailbox-mcp:0.3.0-amd64` (== 0.2.0 digest `f4f91f26`). Push needs `--profile breakglass` (short-lived; user re-auths `aws sso login --profile breakglass`).
- LIVE in kelos-pilot: `deploy/mailbox-mcp` 1/1 (running 0.2.0==0.3.0 code); `session/inpulse-collab` Suspended; tasks `collab-probe-2/-3` Succeeded (ttl-clean ~1h). Secrets `mailbox-secrets`, `collab-bridge-headers`, PVC `mailbox-data`.
- beads: home DB schema-blocked (v11 vs v19) — do NOT auto-migrate; tracking here instead

## RESUME KICKOFF (next session)
1. Read this ledger. Optionally `Skill("commit")` the uncommitted fork changes first (safety).
2. **Decide ① vs ②** (see ARCHITECTURE RECONSIDER above) — ② (escalate-and-resume) likely more robust; if staying on ①, continue below.
3. **Confirm CAUSE 1 mechanism (B stale-read vs C unflushed-response):** add a server-side log line where `ask_human` returns; redeploy; re-probe (`collab-probe-4`), reply at +30s, read mailbox-pod logs to see if the handler detected+returned. B → fix store connection/txn; C → fix SSE response flush.
4. **CAUSE 2:** find the real claude-code var for the 120s drop (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` had no effect) or treat 120s as a hard ceiling (favors ②).
5. Re-probe loop: `kubectl --context <ctx> apply -f deploy/kelos-pilot/probe-task.yaml` → wait → `MB_TOKEN=$(cat ~/.mailbox-local-token) MB_URL=http://127.0.0.1:8137/mcp bun scripts/mb-client.mjs answer 4` (needs a port-forward) → expect `GOT REPLY: 4`.
