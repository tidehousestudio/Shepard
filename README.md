# Shepard

An autonomous maintenance and reliability system for software repositories.

Shepard answers one question — **is this application still behaving correctly?** —
and has to earn the right to answer it. It learns a repository, boots the
application, uses it the way a person would, and decides whether it is healthy
enough to take responsibility for. A repository being connected does not mean
Shepard has accepted it.

> Don't look at Shepard. Shepard is looking at your software.

## What is here

| Command | What it does |
|---|---|
| `shepard audit <path>` | Learn a repository, boot it, verify it, decide on acceptance |
| `shepard findings <path>` | What is wrong, and what is already known |
| `shepard status <path>` | Health, coverage, capability level |
| `shepard selftest <path>` | Plant known defects in throwaway copies and measure what Shepard catches |
| `shepard watch <path>` | Serve the screen |

```
npm install && npm run build
node dist/cli.js audit fixtures/demo-shop --port 3000
```

## How it decides things

**Verified healthy, verified broken and unverified are three different states**,
and the third never quietly becomes the first. When credentials, environments or
safety restrictions stop Shepard from testing something, it says so.

**An expectation read from the code under test cannot prove that code correct.**
Delete a button's click handler and the code-derived expectation becomes "this
button does nothing", which the broken button satisfies perfectly. So Shepard
draws expectations from sources that are independent of the implementation —
what a control's affordance promises, what two layers agree on, what the last
accepted baseline contained, and what holds for any application at all — and the
rule lives in `src/knowledge/verdict.ts` rather than in a design document.

**Enumeration is mechanical; judgement is not.** Routes, endpoints, tables,
policies and controls are found by parsers and crawlers, because absence is the
shape of most defects and absence is what a language model misses. A model is
asked about items already on the list, never for the list.

**Failure to run an application is graduated.** Shepard climbs a capability
ladder — static, builds, boots, persists, authenticated, integrated — and reports
where it stopped and what it needs to go further, rather than reporting nothing.

**Findings have identity.** They are fingerprinted on semantic location and
failure class, never on line numbers or message text, so New, Known, Resolved and
Recurrence are computed rather than guessed.

**Candidates must reproduce before they are reported.** A check that cannot make
up its mind is a hole in Shepard's vision, not a fact about your application.

## Testing Shepard itself

`shepard selftest` plants defects in a throwaway copy of an application and
measures whether Shepard found them — an inert control, a broken link, a failing
API, a deleted authorization check, a write endpoint that silently rejects what
the UI sends. The point is not that Shepard can find these five bugs. It is to
measure sensitivity per defect class, so that a miss is fixed in the general
methodology rather than special-cased.

## Model access

Detection does not need a model. Enumeration, booting, browser execution and
every universal invariant are mechanical, which is why the planted-defect suite
runs with no API key at all. A model is needed to say what an application *is*
and what a surface is *for*; that sits behind `ModelProvider` and reports itself
as unavailable rather than degrading silently.

## Design

- [`docs/design/architecture.md`](docs/design/architecture.md) — the oracle problem and what follows from it
- [`docs/design/approach.md`](docs/design/approach.md) — the approved approach and build order
- [`docs/design/environment.md`](docs/design/environment.md) — measured build-environment constraints

`fixtures/demo-shop` is a small application used as a proving ground. It is not
part of Shepard.
