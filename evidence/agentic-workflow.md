# Agentic Workflow

## Summary

**Harness**
- Claude Code + Opus 5.5 / Sonnet 5.5
- [Superpowers](https://github.com/obra/superpowers) (spec-driven development workflow)

**Workflow**
Initialisation phrase: Ideation -> PRD -> Spec (design, architectural decisions, in-depth features) (around 45m)
Build: Plan -> Build -> Review -> Verify (loop)
Finalisation: In-depth code review, security review, and simulated user testing (playwright-cli)

## Initialisation

Ideation was completed using free form chat to get the idea of what to build given the time boxed criteria. The build was intentionally scoped to FSI / Banking related. The output of this step is a PRD document which get edited and converted to `evidence/intent.md` file.

From the PRD/intent.md file skill `brainstorm` for the initial spec (and the only one for this slice). This is a multi-turn conversations with all the technical components and architectural decisions done primarily by human. The output of this step is a markdown file `docs/superpowers/specs/2026-11-07-secure-doc-portal-design.md`.

Project setup was done manual with a simple `bun init` and superpowers related skills are added.

Bun + Elysia was chosen primarily for development speed but both are well matured tools that are being used in many platform including enterprises.

`.claude/skills/software-design-principles/SKILL.md` is a personal skill curated and use for steering agent design principles.

UI/UX was intentionally left unmanaged as we are looking for functional workflow only.

## Build

### Plan

Primary agent is loaded with context from the spec and prompted to breakdown the spec into small chunks, the scope of each chunks are agreed within the session and the agent build plan using `writing-plans` skill. The plan have significant technical details embedded and this is fully reviewed manually before committing.

### Build

Once the plan is manually reviewed and approved, the orchestrator agent invoke a sub-agent to implement the plan. The skill `software-design-principles` is cued to load on every sub-agent calls to steer the implementation. Each implementation is completed in a git-subtree except for the initial build step that was performed directly in context by the primary agent.

### Review

Once the sub-agent completed the task the sub-agent, a hook will trigger for a brief security review by another sub-agent, the implementation agent will fix any security issues flagged within the session. Once completed it will perform another self-review loop against the set of changes. Once completed and the changes are handed back to the primary agent, it will invoke another sub-agent to perform a full review on the changes again.

### Verify

Final pass on the loop is manual verification, this includes manual code review and agent guided UI exploration using playwright-cli as well as manual testing via the UI.

## Finalisation

The agent perform a full in-depth code review, security review (via Claude built-in `security-review` skill) and a full end-to-end user testing and a final review on the evidence pack.
