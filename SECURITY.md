# Security Policy

## Supported versions

Only the [latest release](https://github.com/cvl121/openchat/releases) is
supported. OpenChat is in beta; fixes ship as new releases rather than
backports.

## Reporting a vulnerability

Please report vulnerabilities **privately** via
[GitHub's private vulnerability reporting](https://github.com/cvl121/openchat/security/advisories/new)
— do not open a public issue.

OpenChat has a single maintainer. You should normally get an acknowledgment
within a week; verified issues are fixed in the next release (the project
ships at least monthly).

## Scope

Reports are especially welcome for:

- API key handling (encryption at rest, what reaches disk or logs)
- Parsing of imported files — character card PNGs, JSONL chats, world-info
  and preset JSON
- The `tavern://` protocol handler and anything that could load remote
  content or execute script in the renderer
- The update check and CI/release pipeline

Out of scope: vulnerabilities in the AI providers themselves, and issues
requiring an already-compromised machine.
