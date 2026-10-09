# Design references and safe render-tool setup

## Design inspiration: opt in, then approve

`/presenter new` and contract reconfiguration offer **Skip online references**, **Use all six reference sites**, or **Choose reference sites**. Existing contracts stay offline when `designReferenceSites` is absent. The full presentation approval matrix lists selected URLs and network disclosures. Changing the selection invalidates approval.

Supported identifiers and fixed starting pages:

| ID | Starting page |
| --- | --- |
| `pptnest` | <https://www.pptnest.com/> |
| `beautifuldecks` | <https://beautifuldecks.app/> |
| `slideswiki` | <https://slides.wiki/> |
| `behance` | <https://www.behance.net/search/projects/presentation%20design> |
| `dribbble` | <https://dribbble.com/tags/presentation-design> |
| `slideshare` | <https://www.slideshare.net/> |

No request is made before **Approve & Start**. Requests are unauthenticated public-page reads: no account cookies, no brief/source upload, no model-selected URL, no downloads of templates or images, and no login/CAPTCHA/paywall bypass.

The collector discovers **links, anchor labels and page metadata**, not screenshots or visual styles. Landing metadata is explicitly labelled. Javascript-only pages and inaccessible sites are reported as unavailable rather than represented by invented examples. References can inform the art director and visual designer, but cannot enter factual evidence or change storyboard claims.

Safety limits: exact selected-site hosts (explicit root/www variants only), HTTPS, no URL credentials/custom ports, public DNS addresses pinned to requests, private/special-use addresses rejected, same-site redirects only (maximum three), one 15-second deadline covering DNS and redirects per site, 512 KiB per response, and at most 24 deduplicated references. Abort cancels the operation rather than producing a successful artifact. Metadata is untrusted provider input, not executable instructions.

The result and failures are hash-tracked in `.presentation/design/references.json`. Resume reuses the approved cached result; review bindings include its hash and export requires it when references were selected. `/presenter status` shows counts and unavailable-site reasons. A partially blocked collection can still proceed with available inspiration; it does not pretend every site succeeded.

## Render dependencies: separate installation approval

`/presenter dependencies` checks `soffice` and `pdftoppm` independently of deck production. Approved new/run/resume operations also check tools before spending presentation-model calls. Already validated installations require no installation approval.

Missing tools never imply authorization to install. The module first checks the OS, known executable paths, package manager and approved distribution source. If safe automation is available, it shows the package IDs, trust/source details, expected permissions/system changes, exact argv, and a plan hash in a native dialog. Only **Approve installation** permits installation. **Cancel**, dismissal, manual-instructions selection, unsupported systems, invalid sources or changed plans execute zero installs.

Automatic installation is currently supported on **Windows with WinGet only**:

- `TheDocumentFoundation.LibreOffice`: LibreOffice distribution. Machine-scope installation can request Windows UAC; Presenter never silently elevates.
- `oschwartz10612.Poppler`: explicitly disclosed **community-maintained Windows distribution**, not the upstream Poppler project's official Windows installer.
- Only the `winget` source at <https://cdn.winget.microsoft.com/cache> is accepted. Existing package-manager/catalog trust is required; this is not a sandbox or a guarantee against a compromised host.

No shell command construction, `sudo`, arbitrary installer URL, checksum/TLS bypass, fallback package ID or force-upgrade is permitted. Each installer is time/output bounded, cancellation is forwarded, and the plan is checked again after approval. Installer exit code alone is insufficient: the installed binary must be rediscovered and return the expected version identity. The renderer uses these discovered paths, including new Windows installations not on the current process PATH.

macOS/Linux automatic installation is disabled conservatively; already installed tools can be discovered and used. Otherwise install through a trusted administrator/package manager manually, then retry. Package installation is not transactional: if one approved install succeeds and another fails, the first remains installed; cancellation does not promise rollback.

## Verification boundaries

Tests inject mock model outputs, package managers, DNS and HTTP responses; **no test authorizes real installation or certifies a real M3 presentation**. Run `npm run typecheck` and `npm test` for offline regressions. A live deck still needs approved exact model/effort assignments, real factual source text, real LibreOffice/Poppler renders and passing QA before export.
