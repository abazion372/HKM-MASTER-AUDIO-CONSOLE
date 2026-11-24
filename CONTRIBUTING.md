# Contributing to HKM Audio System

Thanks for your interest in improving the HKM Audio System console. This document covers setup, code style, and the pull request process.

## Development Setup

**Prerequisites**

- [Bun](https://bun.sh) 1.1+ — required (the WebSocket mini-service only runs under Bun)
- Git

**Steps**

```bash
git clone https://github.com/abazion372/HKM-MASTER-AUDIO-CONSOLE.git
cd HKM-MASTER-AUDIO-CONSOLE
bun install
bun run db:generate
bun run db:push
bun run dev                        # web app  → http://localhost:3000
```

Optional, for remote-companion features:

```bash
cd mini-services/audio-ws && bun run dev    # ws://localhost:3030
```

## Project Conventions

- **Language**: TypeScript 5 in strict mode throughout. No plain JavaScript in `src/`.
- **Client/server split**: use `use client` / `use server` directives; keep server-only SDK usage (including `z-ai-web-dev-sdk`) in API routes or server modules — never in client components.
- **APIs**: new endpoints belong under `src/app/api/<namespace>/route.ts` and must return typed JSON responses.
- **UI**: prefer existing shadcn/ui primitives in `src/components/ui/` before building custom components. Follow the established card alignment/padding conventions (`p-4`/`p-6`, `gap-4`/`gap-6`).
- **State**: Zustand for client state, TanStack Query for server state, the JSON store (`src/lib/hkm-store.ts`) for shared console state.
- **Styling**: Tailwind CSS 4 utility classes with the project theme tokens (`bg-background`, `text-primary-foreground`, ...). Avoid hardcoded hex colors.
- **Data**: the Prisma schema lives in `prisma/schema.prisma`; primitive types only (no arrays). Run `bun run db:push` after schema changes.
- **Realtime**: all realtime features go through the WebSocket mini-service in `mini-services/audio-ws` — do not introduce alternative transport mechanisms.

## Code Quality

Before opening a PR, make sure both pass:

```bash
bun run lint    # ESLint — must exit clean
bun run build   # Next.js production build — must succeed
```

The CI workflow runs lint on every push and pull request.

## Branching & Commits

- Branch from `main` using a descriptive name: `feat/feedback-detector`, `fix/ws-reconnect`, `docs/api-reference`
- Commit messages: use the imperative mood and reference the area, e.g. `feat(midi): add mapping import`, `fix(console): correct meter decay`

## Pull Request Process

1. Ensure `bun run lint` and `bun run build` pass locally.
2. Open a pull request against `main` using the PR template.
3. Describe what changed and why; link any related issues.
4. Keep PRs focused — one feature or fix per PR.
5. Update `CHANGELOG.md` under `[Unreleased]` for user-facing changes.

## Reporting Issues

Use the GitHub issue templates ([bug report](.github/ISSUE_TEMPLATE/bug_report.md) / [feature request](.github/ISSUE_TEMPLATE/feature_request.md)) and include reproduction steps, expected vs. actual behavior, and environment details (OS, Bun version, app version).

## Security Issues

Do not open public issues for security vulnerabilities — follow [SECURITY.md](SECURITY.md).
