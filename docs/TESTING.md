# Release QA

## Automated checks on Windows

Use the Node.js version in `.node-version` and a clean checkout. No real accounts are required.

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run check:source
npm run check
npm test
npm --prefix qa ci --ignore-scripts --no-audit --no-fund
npm --prefix qa run browsers
npm run test:ui
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1 -Zip
npm run build:single
npm run verify:release
npm run smoke:release
```

`verify:release` reads both the ZIP and the embedded ZIP resource in the EXE without running the launcher. It compares entries against a hash manifest, checks the bundled Node binary and checks first-party files against the current checkout. It also checks the native product version and writes SHA256SUMS. Changes to the source after building intentionally fail this check: rebuild before verification.

`smoke:release` starts the packaged Node executable and packaged service with an isolated temporary profile. It tests API authentication, assets, profile encryption and restart, stored language, startup theme and metadata, and the 500-account demo. It checks that changing the interface language leaves message data unchanged. It never requests mailbox synchronization. It closes its child processes and removes only its own temporary test profile.

These are package and service tests. They do not test Windows UI rendering, a missing WebView2 installation or a real Microsoft tenant. The Windows Server CI runners are not substitutes for clean Windows 10/11 desktops.

`test:ui` runs separately in `qa/`. It checks keyboard focus after selecting mail and saving account data, all 500 virtualized accounts, partial settings updates, busy forms, errors, cancelled/oversized file reads and layout at large text sizes in Russian, English and Ukrainian. Startup tests block the application module and verify that every theme already has the correct page background, including both system color schemes; cancelling a preview preserves the saved theme. Its browser and dependencies are not part of the release package. Test data is fictional; the server's mail worker is not started. Local runs may use `POSTA_QA_CHROME` to point to an installed Chrome executable. CI uses Playwright's test Chromium.

## Manual desktop checks before calling a release stable

Record Windows build, architecture, display scale, package hash, test date and result. Use virtual machines or separate test environments, not a user's normal profile.

| Environment / scenario | Required result | Current status |
| --- | --- | --- |
| Clean Windows 10 and 11 x64 | ZIP and single EXE open without installing Node.js | Pending |
| Read-only application folder | Localized failure; no token or process output exposed | Pending |
| Paths containing spaces and Cyrillic | Launch and save/reopen the profile | Local path with spaces checked; clean-machine repeat pending |
| 100%, 125%, 150%, 200% display scale | No clipped dialogs, hidden actions or overlapping text | Full matrix pending |
| Russian, English, Ukrainian | Immediate preview, cancel, save, restart; mail unchanged | Locally checked; independent language review pending |
| Light and dark, maximum text, all reader positions | Main actions and focused controls stay visible | Locally checked in 1.2; repeat on final release required |
| Keyboard | Import, search, settings tabs, table, reader, dialogs reachable; focus returns correctly | Browser regressions automated; native desktop pass pending |
| 10 / 100 / 500 demo accounts | Search before paging; smooth scrolling; only visible sidebar rows rendered | Local tests and demo checks; clean-machine repeat pending |
| Outlook.com and Microsoft 365 test tenants | Import, read-only inbox/junk, token rotation, expired/revoked access, disconnect/reconnect | One authorized Outlook.com inbox read and token/restart flow checked locally; expanded provider matrix pending |
| Provider throttling | Retry-After and global hold honored; no retry loop | Simulated tests pass; provider QA pending |
| Upgrade and rollback | Backup before upgrade; labels and pauses retained; old EXE preserved | Automated migration checks; user acceptance pending |

Do not create provider throttling by flooding a real tenant. Use the injected loaders and simulated responses in the offline tests. Use only accounts and OAuth applications that the tester is authorized to access.

Optional compatibility checks include a Windows installation without WebView2 and assistive technology testing. They are not release gates. Keep the localized missing-runtime message and existing keyboard/accessibility support.

Storage failure regressions inject a failed save using fictional data. They verify that polling reveals the paused queue, a failed account resume rolls back, concurrent HTTP edits do not overwrite each other after a failure, and a closed vault refuses late writes. Pause/close regressions hold the cooldown save and check that no provider request starts after a pause or shutdown; a global pause retains the unstarted task, while an account pause leaves its status paused. Browser tests cover pending and failed pause/resume commands, retained form drafts, and disabled auto/pause toggles with keyboard focus restored after completion.

## Publication gate

Before publishing a stable release, complete RELEASE_CHECKLIST.md, choose a project license, configure a working private vulnerability reporting channel and record the manual results. The repository currently has no remote. A local passing run must not be reported as a passing GitHub Actions run.

GitHub references: [runner environments](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [secure workflow guidance](https://docs.github.com/en/actions/reference/security/secure-use), [private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
