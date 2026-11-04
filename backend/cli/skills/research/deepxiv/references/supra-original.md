---
name: deepxiv
description: Search and progressively read open-access academic papers through DeepXiv. Use when the user wants layered paper access, section-level reading, trending papers, or DeepXiv-backed literature retrieval.
argument-hint: [query-or-paper-id]
allowed-tools: Bash(*), Read, Write
---

# DeepXiv Paper Search & Progressive Reading

Search topic or paper ID: $ARGUMENTS

## Role & Positioning

DeepXiv is the **progressive-reading** literature source:

| Skill | Source | Best for |
|-------|--------|----------|
| `/arxiv` | arXiv API | Batch search, PDF download, metadata |
| **`/deepxiv`** | **DeepXiv SDK** | **Progressive section-level reading** |
| `/semantic-scholar` | S2 API | Published venue metadata, citation counts |
| `/alphaxiv` | alphaxiv.org | Instant LLM-optimized summary of one paper, with LaTeX source fallback |

Use DeepXiv when you want to avoid loading full papers too early.

## Constants

- **DEEPXIV_FETCHER** — project-local helper at `tools/deepxiv_fetch.py`.
  If unresolved, fall back to the raw `deepxiv` CLI documented per
  command below.
- **MAX_RESULTS = 10** — Default number of results to return.

> Overrides (append to arguments):
> - `/deepxiv "agent memory" - max: 5` — top 5 results
> - `/deepxiv "2409.05591" - brief` — quick paper summary
> - `/deepxiv "2409.05591" - head` — metadata + section overview
> - `/deepxiv "2409.05591" - section: Introduction` — read one section only
> - `/deepxiv "trending" - days: 14 - max: 10` — trending papers
> - `/deepxiv "karpathy" - web` — DeepXiv web search
> - `/deepxiv "258001" - sc` — Semantic Scholar metadata by ID

## Setup

DeepXiv is optional. If the CLI is not installed, tell the user:

```bash
pip install deepxiv-sdk
```

On first use, `deepxiv` auto-registers a free token and stores it in `~/.env`.

## Workflow

### Step 1: Parse Arguments

Parse `$ARGUMENTS` for:

- **Query or ID**: a paper topic, arXiv ID, or Semantic Scholar ID
- **`- max: N`**: override `MAX_RESULTS`
- **`- brief`**: fetch paper brief
- **`- head`**: fetch metadata and section map
- **`- section: NAME`**: fetch one named section
- **`- trending`** or query `trending`: fetch trending papers
- **`- days: 7|14|30`**: trending time window
- **`- web`**: run DeepXiv web search
- **`- sc`**: fetch Semantic Scholar metadata by ID

If the main argument looks like an arXiv ID and no explicit mode is given, default to `- brief`.

### Step 2: Locate the Adapter

Resolve `$DEEPXIV_FETCHER` from the current SupraMAS project root.
Policy D1 cascade: the resolved adapter is preferred; if unresolved
(canonical chain exhausted), fall back to raw `deepxiv` CLI commands
documented in Step 3.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT" || exit 1
DEEPXIV_FETCHER="$REPO_ROOT/tools/deepxiv_fetch.py"
[ -f "$DEEPXIV_FETCHER" ] || DEEPXIV_FETCHER=""

# Smoke test (optional — adapter resolution shown to user). The cascade
# in Step 3 below branches purely on `[ -n "$DEEPXIV_FETCHER" ]`; a
# resolved-but-non-functional adapter is not currently auto-demoted.
if [ -n "$DEEPXIV_FETCHER" ]; then
  echo "DeepXiv adapter resolved at: $DEEPXIV_FETCHER" >&2
else
  echo "DeepXiv adapter unresolved (canonical chain exhausted); raw deepxiv CLI fallback will be used." >&2
fi
```

### Step 3: Execute the Minimal Command

**Search papers**

```bash
python3 "$DEEPXIV_FETCHER" search "QUERY" --max MAX_RESULTS
```

Fallback:

```bash
deepxiv search "QUERY" --limit MAX_RESULTS --format json
```

**Brief summary**

```bash
python3 "$DEEPXIV_FETCHER" paper-brief ARXIV_ID
```

Fallback:

```bash
deepxiv paper ARXIV_ID --brief --format json
```

**Section map**

```bash
python3 "$DEEPXIV_FETCHER" paper-head ARXIV_ID
```

Fallback:

```bash
deepxiv paper ARXIV_ID --head --format json
```

**Specific section**

```bash
python3 "$DEEPXIV_FETCHER" paper-section ARXIV_ID "SECTION_NAME"
```

Fallback:

```bash
deepxiv paper ARXIV_ID --section "SECTION_NAME" --format json
```

**Trending**

```bash
python3 "$DEEPXIV_FETCHER" trending --days 7 --max MAX_RESULTS
```

Fallback:

```bash
deepxiv trending --days 7 --limit MAX_RESULTS --output json
```

**Web search**

```bash
python3 "$DEEPXIV_FETCHER" wsearch "QUERY"
```

Fallback:

```bash
deepxiv wsearch "QUERY" --output json
```

**Semantic Scholar metadata**

```bash
python3 "$DEEPXIV_FETCHER" sc "SEMANTIC_SCHOLAR_ID"
```

Fallback:

```bash
deepxiv sc "SEMANTIC_SCHOLAR_ID" --output json
```

### Step 4: Present Results

When searching, present a compact table:

```text
| # | ID | Title | Year | Citations | Notes |
|---|----|-------|------|-----------|-------|
```

When reading a paper, show:

- title
- arXiv ID
- authors
- venue/date if available
- TLDR or abstract summary
- suggested next step: `brief` → `head` → `section`

### Step 5: Escalate Depth Only When Needed

Use this progression:

1. `search`
2. `paper-brief`
3. `paper-head`
4. `paper-section`
5. full paper only if necessary

Do not jump to full-paper reads when a brief or one section answers the question.

### Step 6: Update Research Wiki (if active)

**Required when `research-wiki/` exists in the project**; skip silently
otherwise. When the wiki dir exists, resolve `$WIKI_SCRIPT` from the
current project root and warn-and-skip if `tools/research_wiki.py` is
missing. Ingest papers that were meaningfully read (brief / head /
section / full) during this invocation — mere `search` hits without a
depth read do not need ingestion:

```bash
if [ -d research-wiki/ ]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  cd "$REPO_ROOT" || exit 1
  WIKI_SCRIPT="$REPO_ROOT/tools/research_wiki.py"
  [ -f "$WIKI_SCRIPT" ] || {
    echo "WARN: tools/research_wiki.py not found; depth-read summary delivered, wiki ingest skipped." >&2
    WIKI_SCRIPT=""
  }
  if [ -n "$WIKI_SCRIPT" ]; then
    for each arxiv_id the user asked this skill to read in depth:
        python3 "$WIKI_SCRIPT" ingest_paper research-wiki/ \
            --arxiv-id "<arxiv_id>"
  fi
fi
```

The optional project-local helper handles metadata / slug / dedup /
page / index / log in one call — **do not handwrite
`papers/<slug>.md`**. Backfill missed ingests with `python3
"$WIKI_SCRIPT" sync research-wiki/ --arxiv-ids <id1>,<id2>,...` after
resolving `$WIKI_SCRIPT` as above.

## Key Rules

- Prefer the adapter script over raw `deepxiv` commands when available.
- DeepXiv is optional. If unavailable, give the install command and suggest `/arxiv` or `/research-lit "topic" - sources: web`.
- Use section-level reads to save tokens.
- Treat DeepXiv as complementary to `/arxiv` and `/semantic-scholar`, not a replacement.
- If the result overlaps with a published venue paper from Semantic Scholar, keep the richer venue metadata in the final summary.
