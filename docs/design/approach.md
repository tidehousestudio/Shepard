# Shepard — Final Approach

Status: approved design, pre-build. Written 2026-09-21.
Follows [architecture.md](./architecture.md) and [environment.md](./environment.md).

Three things drive this document: resolving the dangers named in the analysis,
making the model API a late dependency rather than a prerequisite, and building
Shepard's structure out of how its underlying agent actually works rather than out
of a generic agent design.

---

## 1. Building Shepard from its own nature

Shepard is a Claude agent wearing a product. The honest move is to design it around
what that agent is reliably good at and structurally bad at, rather than around what
an idealised agent would be. What follows is introspection turned into constraints.

### 1.1 The enumerator is code; the judge is the model

The most important one.

The agent notices anomalies well and notices *absence* badly. It will spot a strange
line in a file. It will not spot that a control has no handler, that a route has no
test, that a policy is never exercised — unless something forces it to walk a
complete list. And absence is exactly the shape of most planted defects: a deleted
handler, a removed check, a dropped write.

So: **nothing that can be enumerated mechanically is ever left to the model.** Routes,
controls, endpoints, tables, policies, links, roles — all extracted by parsers and
crawlers. The model is then asked about each enumerated item, one at a time. This
inverts the usual agent design, where the model is asked "what's here?" It also
happens to be the cheap direction, because parsing is free and judgement is not.

### 1.2 Execute rather than predict

The agent is markedly better at verifying than at predicting. Given an assertion and
a way to run it, it is reliable; asked what a function will do, it is merely
plausible. Shepard should therefore maximise the ratio of execution to speculation,
and prefer booting the thing and looking even when reasoning would be cheaper. Every
claim in the knowledge store carries a provenance pointer to the tool output that
produced it. **A claim without provenance is inadmissible** — it cannot support a
verdict and cannot enter a baseline.

### 1.3 Bounded calls, fresh context, typed output

The agent degrades with context length, and it degrades *confidently* — the failure
mode is a fluent wrong answer, not an admission of doubt. So Shepard is many small
agents with narrow jobs and typed outputs, never one long conversation. In
particular, adjudication (does this observation match this expectation?) is a short
call holding only the expectation and the observation. It is never the tail end of a
long investigation, because that is precisely where a tired context invents a pass.

### 1.4 Blind passes, then reconcile

The agent is suggestible. Told the app is a café platform, it will find café-platform
things; shown a `// TODO: broken` comment, it anchors. Discovery therefore runs as
multiple independent passes over the same repository — by layer, by entry point, by
data model — that cannot see each other's conclusions, followed by a reconciliation
step. **Disagreement between passes is signal**, either genuine ambiguity or evidence
that one pass anchored, and it is recorded rather than smoothed over.

This is also the mechanical reason the user must not describe their app before
onboarding, beyond it being a trust exercise: a description would contaminate every
pass identically and remove the only independent check available.

### 1.5 Render prose from rows, never the reverse

The agent confabulates most when asked to summarise and least when asked to cite. So
the understanding report is generated as typed rows with evidence pointers, and the
prose the user reads is rendered from those rows. Any sentence with no row behind it
does not get written. This is also what makes user corrections actionable: a
correction lands on a row with a provenance trail, not on a paragraph.

### 1.6 Persist the investigation, not just the conclusions

Sessions end. Context compacts. What the agent actually needs on resume is not a pile
of facts but *the state of its own inquiry*: what it was doing, what it had ruled
out, what it was about to check next. So the knowledge store holds an `investigation`
entity — open questions, hypotheses, refuted hypotheses, pending probes — alongside
conclusions. This is what makes an hour-long onboarding resumable rather than
restartable, and it is the difference between a system that accumulates and one that
merely remembers.

### 1.7 Hypotheses, not vibes

Asked to "look for bugs," the agent produces plausible generic findings. Given a
hypothesis and a way to test it, it produces reproductions. Every finding therefore
passes through: hypothesis → predicted observation → probe → confirm or refute. A
suspicion that was never stated falsifiably and then tested does not become a
finding; it becomes an open question in the investigation record, which is a
different and more honest thing.

### 1.8 Never let the model score itself

The agent is overconfident about being done. So coverage is computed mechanically
from the enumerated surface, never asserted. Acceptance is a mechanical gate
evaluated against the baseline manifest, never a judgement call that things look
broadly fine. The model may argue; it does not hold the gate.

### 1.9 Knowledge decays

Shepard's own memory is a source of error over time. Every row carries the commit at
which it was verified. When HEAD moves past the provenance of a row that covers
changed code, the row is marked stale and queued for re-derivation rather than
trusted. Shepard distrusting its own old conclusions is a feature.

---

## 2. Resolving the dangers

### 2.1 Booting an unfamiliar application

The blocker becomes a **capability ladder**, so that failure is graduated and
specific rather than binary:

| Level | Meaning | What becomes verifiable |
|---|---|---|
| L0 | Static only | Nothing. All behaviour `unverified` |
| L1 | Builds | Install, typecheck and build succeed. Build failures are findings |
| L2 | Boots | Server responds. Routes crawlable, controls probeable, console and network observable |
| L3 | Persists | Database provisioned, migrations applied. Database assertions possible |
| L4 | Authenticated | Test identities exist per discovered role. Auth matrix testable |
| L5 | Integrated | Outbound calls stubbed and observable. Integration behaviour testable |

Shepard reports its level explicitly and scopes coverage and health to it. "Reached
L2; needs `DATABASE_URL` and two API keys to reach L3" is a useful, actionable state.
"Failed to run" is not.

Acquisition works from evidence in the repository, in descending order of
reliability: **CI workflows first** — they are a working, maintained recipe for
building the app, written by people who know it — then compose files, then
`.env.example` and config schemas, then package scripts, then framework convention.
The result is an *acquisition recipe* stored in the knowledge store, correctable once
by the user and persistent thereafter. Every unmet requirement is surfaced as a
precise, minimal ask.

### 2.2 Test identities

Three tiers, attempted in order:

1. **Self-registration.** Shepard discovers the signup flow and creates its own
   identities. Preferred, and it doubles as verification of the registration journey.
2. **Direct provisioning.** At L3, insert identities against the discovered auth
   schema.
3. **Supplied credentials.** Requested precisely, per role, and only for what the
   first two could not produce.

Roles are discovered mechanically from schema, policies and route guards, so Shepard
always knows how many roles it has *failed* to obtain and reports the auth matrix as
explicit coverage rather than silence.

### 2.3 Empty databases hide bugs

**State is built through the product, not inserted.** Shepard derives a state
construction plan from the journey graph — fulfilment needs an order, which needs a
product and a customer — and executes those journeys in dependency order. Seeding is
therefore itself a verification of the creation journeys, and the state under test is
state the application actually produced.

Direct insertion is a fallback and is marked as such: state built by use is stronger
evidence than state built by insert. Seeding is deliberately plural — multiple
tenants, multiple rows — because single-tenant, single-row data hides exactly the
tenant-isolation and pagination defects that matter most.

### 2.4 Cost and time

Three levers, in order of effect. The enumerator/judge split (§1.1) removes most
model calls from discovery outright. The replay/triage split keeps recurring audits
deterministic, so ongoing cost is near-flat in repository size. And each cycle runs
against a budget with severity-ordered selection, so an over-large repository
degrades into *reduced coverage, honestly reported* rather than an arbitrary stop or
an unbounded bill.

Onboarding time is budgeted against discovered surface size, not the clock. An hour
on a small application is waste; on a large one it may be nowhere near enough.

### 2.5 Non-determinism and flake

The model is kept out of the execution path entirely, so re-runs are byte-comparable.
On top of that: a candidate failure must reproduce under independent re-execution
before it becomes a finding. A case that flips repeatedly is quarantined as
`unstable` and reported as a **coverage** problem rather than a health problem —
because a check that cannot be trusted is a hole in Shepard's vision, not a fact
about the application. During onboarding, a case must demonstrate stability across
repeated runs before it is allowed into the baseline at all.

### 2.6 Shepard trusting itself

Covered by §1.9: provenance and commit-stamped staleness, with re-derivation rather
than inherited belief.

---

## 3. Building without the model API

The API key is a late dependency. Sorting the system by what genuinely needs
judgement:

**Needs the model:** comprehension and naming, the understanding report, case
generation from discovered surface, adjudication of ambiguous observations,
investigation and root-cause work, correction handling, chat.

**Does not:** repository inventory and parsing; enumeration of routes, controls,
endpoints, tables, policies and roles; environment acquisition and boot; crawling;
browser execution and evidence capture; database assertions; every universal
invariant — console errors, 4xx and 5xx, broken links, inert controls, auth-boundary
negatives; finding fingerprinting and lifecycle; health and coverage computation;
baseline manifests; scheduling; the interface and pixel scene; the mutation harness.

That second list is most of the system, and it includes the entire deterministic
detection engine. The consequence worth stating plainly: **the planted-defect test
can be run with no model calls at all.** Dead controls, broken links, bad status
codes, console failures and authorisation leaks are all mechanically detectable. The
key buys understanding and explanation — which is most of Shepard's *value* — but
detection does not wait on it.

A prototype of the detector is in [`prototypes/dead-control/`](../../prototypes/dead-control/);
it finds a planted inert button and a planted broken link in a fixture app with no
knowledge of what the app is and no model involvement.

Implementation: all model use goes behind a `ModelProvider` interface with typed
prompt/response contracts per stage. Two offline providers exist alongside the real
one — a deterministic heuristic provider (rule-based naming and classification, crude
but structurally valid) and a recorded-fixture provider for tests. The day the key
arrives it is configuration, not a refactor.

---

## 4. Where I disagree with the brief

### 4.1 "Do not accept a repository determined to be broken" is too strong as written

Applied literally, no real application passes. Every mature codebase has a broken
link somewhere, a console warning, a failing edge case. If acceptance requires the
absence of all defects, Shepard denies everything forever and the product never
reaches its actual purpose, which is ongoing maintenance.

The requirement's real intent is sound — don't learn broken behaviour as the healthy
baseline. That intent is satisfied by a severity-and-coverage gate rather than a
purity test:

Shepard accepts when **all** of:
- environment acquisition reached L3 or better;
- no verified-broken finding at critical severity;
- every core journey has at least one passing end-to-end case;
- no core journey is unverified;
- every discovered role × protected-surface pair has a negative-case result;
- coverage of critical-severity surface is at or above threshold.

Shepard denies when it cannot verify enough to judge, or when something critical is
verifiably broken. Non-critical known issues do not block acceptance; they are
recorded into the baseline as explicitly accepted known issues, which is what stops
them being relearned as healthy. An accepted application may therefore start life at
`degraded`, and that is correct and honest.

### 4.2 Denial should be re-runnable, not a full re-onboarding

A denial produces a qualification checklist bound to specific findings. When the user
fixes something, Shepard re-verifies the affected cases and updates the checklist
incrementally. The fix-and-requalify loop must cost minutes, not another hour, or
nobody will use it twice.

### 4.3 The pixel scene should be built early, not late

The brief rightly says animation must not compromise reliability work. I would still
build the scene early, because it is cheap and it is an honest forcing function: if
the scene cannot render the state, the state machine is not yet defined. It also
makes the `blind` state impossible to quietly skip.

---

## 5. Build order

| Phase | Content | Needs key |
|---|---|---|
| 0 | Knowledge store, evidence store, provenance model, `ModelProvider` seam | No |
| 1 | Repository connect, inventory, mechanical enumeration of the surface | No |
| 2 | Environment acquisition, the capability ladder, boot and seed | No |
| 3 | Execution engine: browser, API, database, stubs, evidence capture | No |
| 4 | Universal invariants: inert controls, broken links, status codes, console, auth matrix | No |
| 5 | Findings lifecycle, health, coverage, baseline manifest, acceptance gate | No |
| 6 | Scheduling and change-aware selection | No |
| 7 | Interface and pixel scene | No |
| 8 | Mutation harness — Shepard's own test suite | No |
| 9 | Comprehension, understanding report, case generation, investigation, chat | **Yes** |

Phases 0–8 are buildable now and constitute a working, honest detection system.
Phase 9 turns detection into understanding.
