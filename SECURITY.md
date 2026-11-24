# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.2.x   | Yes |
| < 0.2   | No |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report privately using one of:

- GitHub's private vulnerability reporting: **Security tab → Report a vulnerability** on this repository
- Email the maintainer via the address listed on the GitHub profile (`abazion372`)

Include in your report:

1. A description of the vulnerability and its impact
2. Steps or proof-of-concept to reproduce it
3. Affected version(s) (see the app version in the console or `package.json`)
4. Any suggested remediation

You should receive an acknowledgment within 72 hours. Please avoid public disclosure until a fix is released.

## Scope Notes

- The desktop app runs its own local Next.js server and WebSocket service (`127.0.0.1` only) — reports about loopback-only exposure should still be filed, but note that localhost-bound services are lower severity.
- Remote companion pairing uses short-lived tokens; token handling weaknesses are in scope.
- Dependency vulnerabilities (npm/Rust) are in scope and will be patched via dependency bumps.
