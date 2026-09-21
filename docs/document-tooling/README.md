# Document Tooling in the Sandbox

This directory explains why the sandbox image and NsJail config carry a set of
document-specific packages, mounts and limits. They exist for one workload:
LibreChat's Office Assistant, whose specialists read and edit `.pptx`, `.docx`,
`.xlsx` and `.pdf` files inside a sandbox job.

Every change here was made on 2026-09-17 after probing a production sandbox and
finding that most of that tooling was either unusable or absent. The symptoms
reached users as silently broken deliverables: a redesigned deck with
overlapping text that no one could have caught, and workbooks whose formulas
were never recalculated.

- What broke and how each piece was fixed → below.
- The changed files → [`api/Dockerfile`](../../api/Dockerfile),
  [`api/config/sandbox.cfg`](../../api/config/sandbox.cfg),
  [`docker/package-init.sh`](../../docker/package-init.sh),
  [`javascript-packages.txt`](../../javascript-packages.txt),
  [`docker-compose.yaml`](../../docker-compose.yaml).

> These are not optional extras. The skills that drive this workload assume
> `soffice`, `zip`/`unzip`, `markitdown` and the `docx` npm package exist, and
> they deliver files without them rather than failing loudly.

---

## The shape of the problem

A sandbox job is a jailed process tree, and jobs see only what
`api/config/sandbox.cfg` mounts. The image is a full Debian system, so a tool
that works when you `docker exec` into the container can still be broken
inside a job. Three of the four root causes below have that shape: the package
was installed, but the part of it that lives outside `/usr` was invisible.

| Symptom in production | Root cause | Fix |
|---|---|---|
| Every `soffice` start aborted with `uno::RuntimeException` (exit 134), even `--version` | Debian links `share/registry/main.xcd` to `/etc/libreoffice/registry/main.xcd`, and `/etc` is not mounted | Bind-mount `/etc/libreoffice` read-only |
| `which: command not found`, though debianutils was installed | `/usr/bin/which` is a symlink into `/etc/alternatives`, which dangles inside the jail. Same for `convert` | Repoint every `/etc/alternatives` symlink at its real binary during the build |
| `markitdown` and `pdfplumber` failed to import | The unmaintained 2019 `pdfminer` dist was installed alongside `pdfminer.six` and overwrote its modules | Drop `pdfminer`; fail the build if the document packages do not import |
| LibreOffice killed mid-conversion with SIGKILL (rc=137) | `cgroup_mem_max` (512 MiB) counts page cache, and a document job's cache plus ~350 MB of process memory exceeds it | Raise to 2 GiB |

---

## LibreOffice

`soffice` is the engine behind slide/PDF rendering, the visual QA step in the
pptx and docx skills, and `recalc.py` in the xlsx skill, which is what computes
formula values after an edit. While it was broken:

- decks were delivered without ever being rendered, so overlapping text and
  overflow reached users;
- workbook formulas were never recalculated.

It needs two things beyond `/usr`:

- **`/etc/libreoffice`** — its configuration registry. Without it, startup
  aborts before anything else happens. Reproducible outside the sandbox by
  replacing `main.xcd` with a dangling symlink: same exception, same exit code.
- **`/etc/fonts`** — fontconfig's configuration. Without it, fontconfig logs
  `Cannot load default config file` and font matching is arbitrary.

**Fonts matter for correctness, not looks.** The skills tell the model to use
Calibri and Cambria because those render true-to-width during QA. That holds
only if the metric-compatible substitutes are installed, so the image now ships
`fonts-crosextra-carlito` and `fonts-crosextra-caladea`. Without them, a slide
that overflows in PowerPoint can look fine in the preview, or the reverse.

## The `/etc/alternatives` trap

Debian points user-facing commands at `/etc/alternatives`, which points at the
real binary. The sandbox mounts almost nothing under `/etc`, so these links
resolve to nothing and the command reports "not found" despite being installed.
`awk` had already been patched this way; `which` and ImageMagick's `convert`
had the same defect.

The build now walks `/usr/bin` and `/usr/sbin`, repoints every link into
`/etc/alternatives` at its resolved target, and **fails if any link into `/etc`
remains**. That last check is the durable part: a future package with the same
layout breaks the build instead of the sandbox.

`magick` is added as an alias for ImageMagick 6's `convert`, because the pdf
skill calls the IM7 entry point that bookworm does not ship.

## Packages the skills assume

| Package | Used by | Note |
|---|---|---|
| `zip`, `unzip` | docx and pptx skills | Editing an existing file is `unzip` → edit the XML → `zip`. Without them the model falls back to Python's zipfile and often fails first |
| `tesseract-ocr` + `eng`, `ben` | pdf skill | `pytesseract` was installed with no engine behind it |
| `imagemagick` | pdf skill | Page-image cropping |
| `libraqm0` | anything drawing Bangla with Pillow | Without it Pillow draws Bangla unshaped: conjuncts fall apart and ি lands after its consonant |
| `uharfbuzz` (Python) | pdf-to-docx skill | Verifies each Bangla word recovered from a PDF by shaping it again. Without it recovery still runs, unverified |
| `docx` (npm) | docx skill | Its document builder. Sandboxes have no network, so it cannot be installed at run time |
| `react`, `react-dom`, `react-icons` (npm) | pptx skill | Icon rendering |
| `python` → `python3` symlink | everything | Models routinely call bare `python`, which CPython's `make install` does not create |

The build fails unless `markitdown`, `pdfplumber`, `pptx`, `docx`, `openpyxl`,
`pypdf` and `pytesseract` all import. That check is what would have caught the
pdfminer conflict, which was silent until a user asked for a file to be read.

## Bangla fonts and OCR

Most Bangla PDFs from Bangladeshi offices are produced by wkhtmltopdf or Qt,
which subset the font down to bare outlines and map conjuncts to no character.
Copied as-is, `বিশ্ববিদ্যালয়` reaches Word as `িব(cid:10)িবদ(cid:11)ালয়`. The
pdf-to-docx skill recovers the real text by matching each embedded glyph
against **the same font installed in the sandbox**, so the font set is part of
the conversion, not decoration: a PDF set in a font missing here cannot be
recovered, and the skill refuses to deliver it rather than ship garbled text.

[`docker/fonts/`](../../docker/fonts/) installs them at build time:

- `fonts.manifest` — what `install-fonts.sh` installs: Debian packages, and
  direct downloads pinned by sha256. A changed file fails the build.
- `fonts.tsv` — the same list for people: family, source, licence, size.
- `60-bangladesh-fonts.conf` — fontconfig aliases for fonts that cannot be
  installed: Vrinda, Nirmala UI and Shonar Bangla (Microsoft, Windows-only) and
  SutonnyOMJ go to the closest free Bangla face; Segoe UI goes to Selawik. It
  also makes Wine's Tahoma, Symbol and Wingdings visible.

The image uses `FONT_SET=recommended`:

| Set | What | Size |
|---|---|---|
| required | SolaimanLipi, Nikosh, Kalpurush, Siyam Rupali, Hind Siliguri, Noto Sans/Serif Bengali, Mukti, Lohit; Carlito, Caladea, Liberation, Gelasio, Selawik, URW base 35, Wine's Tahoma/Symbol/Wingdings | ~72 MB |
| recommended | adds the Nikosh variants, AdorshoLipi, Tiro Bangla, Baloo Da 2, Anek Bangla, Galada, Atma, Mina, Croscore, emoji | ~27 MB |
| all | adds Noto CJK, maths and LaTeX fonts, legacy ANSI Bangla | ~457 MB more |

**Licences.** Nothing is committed to this repository; every file is fetched
from its publisher. Nikosh and its variants are CC BY-NC-ND 3.0 —
non-commercial, unmodified — which fits this service as long as it stays
non-commercial. SutonnyMJ and the other Bijoy fonts are commercial and are not
installed; PDFs set in them cannot be recovered.

OmicronLab, which hosts most of the Bangla fonts, drops TLS connections
intermittently. The installer retries, and `FONT_CACHE=<dir>` points it at a
local copy of the files for a build that must not depend on it.

**OCR.** Tesseract's `ben` and `eng` models are replaced by `tessdata_best`,
pinned to a commit and checked by sha256. On UGC circulars rendered at 300 dpi
it made 0.8% Bangla character errors against 3.4% for Debian's model; on a
degraded scan-like page, 4.5% against 7.7%. OCR is only for scans: a PDF with a
text layer converts exactly, and more accurately than any OCR.

## Job limits

Two limits in `api/config/sandbox.cfg` are the ones a document job actually
hits. Both are commented there as defaults that per-request CLI flags override,
but the override only applies when the sandbox API resolves a positive
`run_memory_limit`; on the production runner it does not. **Treat these config
values as the real ceiling, and `SANDBOX_RUN_MEMORY_LIMIT` in `.env` as a
secondary knob** — raising the env var alone changed nothing in production.

- **`cgroup_mem_max`: 512 MiB → 2 GiB.** The cgroup charge includes the page
  cache of every file the job reads. An interpreter with `markitdown`,
  `pdfplumber`, `pandas` and `python-docx` loaded, plus LibreOffice's own
  libraries, peaks around 350 MB of process memory and far more in cache. At
  512 MiB the kernel killed `soffice` mid-conversion, which surfaced as
  `rc=137` and a guest-kernel line reading
  `Memory cgroup out of memory: Killed process (soffice.bin)`.
- **`cgroup_pids_max`: 64 → 256.** LibreOffice runs a thread per vCPU plus its
  own workers, and `.env` already asked for `SANDBOX_MAX_PROCESS_COUNT=100`,
  which the old cgroup ceiling silently capped below the requested value.

`/tmp` also grew from 20 MB to 256 MB (still `noexec`). LibreOffice writes its
user profile and conversion scratch files there, and 20 MB overflows on
image-heavy decks. tmpfs pages are charged to the job's cgroup, so this stays
bounded by the memory limit above.

A minimal `/etc/passwd` and `/etc/group` for uid/gid 65534 is mounted as inline
content, the same way `/etc/hosts` already was. Without it `getpwuid()` fails,
so `getpass.getuser()` raises for any library that asks who is running.

## Compose passthrough

`docker-compose.yaml` hard-coded the sandbox's sizing, so `.env` values never
reached the running container: the VM ran with 2 GB and 2 vCPUs while `.env`
asked for more, and `SANDBOX_MAX_PROCESS_COUNT` was ignored entirely. The
sizing knobs now read from `.env` with the previous values as defaults.

> **Before deploying, check `LAUNCHER_RAM_MIB` and `LAUNCHER_VCPUS` in `.env`.**
> They now take effect. Size them against what else runs on the host: with a
> 1 GB per-job limit and 8 concurrent jobs, the VM needs ~10 GB to cover the
> worst case.

---

## Verifying a deployment

Run these inside a sandbox job after any rebuild. Each line maps to a failure
above, and all of them passed on a locally built runner before this shipped.

```bash
soffice --headless --norestore -env:UserInstallation=file:///tmp/lo --convert-to pdf deck.pptx
python3 -c "import markitdown, pdfplumber, pptx, docx, openpyxl, pypdf, pytesseract"
node -e "for (const m of ['docx','react','react-dom','react-icons/fa','pptxgenjs','sharp']) require(m)"
for t in which python zip unzip tesseract magick soffice; do command -v $t || echo "MISSING $t"; done
fc-match Calibri; fc-match Cambria          # expect Carlito, Caladea
fc-match SolaimanLipi; fc-match Nikosh      # expect themselves, not DejaVu
tesseract --list-langs | grep -x ben
python3 -c "import fontTools, uharfbuzz"
python3 -c "import getpass; print(getpass.getuser())"
df -h /tmp | tail -1                        # expect 256M
```

Two checks are worth running as a pair, because they fail differently: a job
that only starts LibreOffice may pass while a realistic one is killed. Import
the document libraries **first**, then convert. That ordering is what exposed
the memory ceiling; LibreOffice on its own peaks at ~230 MB and looks fine.

The repo's `test-sandbox.sh` still covers runtimes, network isolation and
syscall hardening. It predates required file names in `/api/v2/execute`, so
every case fails with an empty result until each `files[]` entry carries a
`name`.
