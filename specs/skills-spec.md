# Skills Specification

## Overview

Skills are reusable markdown prompt templates stored as files on disk. Users trigger them via `/skill-name` in the chat input, which replaces the trigger text with the skill body inline — preserving surrounding message text. Skills are discovered from `~/.claude/skills` and an optional vault-relative folder, merged at load time.

## Requirements

- Read `.md` skill files from `~/.claude/skills` (cross-platform: `os.homedir() + '/.claude/skills'`)
- Read `.md` skill files from a configurable vault-relative path (e.g. `Skills/`)
- Both sources are merged; home dir skills take precedence on name collision
- Typing `/` in chat input shows a unified autocomplete dropdown with all templates and skills (filtered as you type)
- Selecting a skill replaces the `/trigger` text with the skill body inline; surrounding message text is preserved
- Selecting a template replaces the entire editor content (existing behavior, unchanged)
- Skill files follow Claude Code format: optional YAML frontmatter with `description` field + markdown body
- Filename (without `.md`) is the skill name / trigger
- New settings field: `chatOptions.skillsVaultPath: string` (vault-relative folder path, default `""`)
- Skills are loaded on plugin startup and refreshed when settings change

## UX Flow

User types: `use /skill1 arg1 and then /skill2 arg2 and summarize`

1. User types `/skill1` → unified dropdown shows matching templates and skills
2. User selects `skill1` → `/skill1` is replaced in-place with skill1's body (as paragraph nodes)
3. Editor now contains: `use [skill1 body] arg1 and then /skill2 arg2 and summarize`
4. User types `/skill2`, selects → same inline replacement
5. Final message: `use [skill1 body] arg1 and then [skill2 body] arg2 and summarize`

The skill body renders inline where the trigger was. The user's surrounding context (including "args") is natural text before/after the inserted body.

## Architecture

### Data Model

```ts
type Skill = {
  name: string        // filename without .md
  description: string // from frontmatter or ""
  body: string        // markdown content after frontmatter
  source: 'home' | 'vault'
}
```

### Settings Schema Addition

In `chatOptions` (`setting.types.ts`):
```ts
skillsVaultPath: z.string().catch('')
```

Migration: `17_to_18.ts` — no data transform, just version bump.

### Components & State

**`src/core/skills/skillsManager.ts`** (new)
- `loadSkills(app: App, skillsVaultPath: string): Promise<Skill[]>`
- Reads home dir via Node.js `fs/promises` + `os.homedir()`
- Reads vault path via `app.vault.adapter.list()` + `app.vault.adapter.read()`
- Parses frontmatter with a simple `---` split regex (no new deps — `gray-matter` is not bundled)
- Merges: home dir skills override vault skills with same name; logs collision at debug level

**`src/hooks/useSkills.ts`** (new)
- `useSkills(): Skill[]` — loads skills via `loadSkills`, re-runs when `settings.chatOptions.skillsVaultPath` changes
- Uses `useSettings()` from settings context for reactivity
- Uses `useApp()` for the vault adapter
- Returns empty array while loading or on error

**`src/components/chat-view/chat-input/plugins/template/TemplatePlugin.tsx`** → rename/replace with **`SlashCommandPlugin.tsx`**
- Unified plugin handling both templates and skills under the `/` trigger
- One `LexicalTypeaheadMenuPlugin` instance (no priority conflict)
- Option type is a discriminated union:
  ```ts
  type SlashOption =
    | { kind: 'template'; name: string; template: Template }
    | { kind: 'skill'; name: string; skill: Skill }
  ```
- Menu item shows `name` + optional `description` (skills have descriptions; templates do not)
- On select — **template**: existing behavior (`parent.splice(nodeToRemove, 1, parsedNodes)`)
- On select — **skill**: replace trigger node with paragraph nodes (see below)

**Skill body insertion:**
```ts
// Split body on newlines, create one paragraph node per line
const lines = skill.body.split('\n')
const paragraphNodes = lines.map((line) => {
  const p = $createParagraphNode()
  if (line) p.append($createTextNode(line))
  return p
})
parent.splice(nodeToRemove.getIndexWithinParent(), 1, paragraphNodes)
paragraphNodes[paragraphNodes.length - 1].selectEnd()
```

**`src/components/chat-view/chat-input/LexicalContentEditable.tsx`**
- Replace `<TemplatePlugin />` with `<SlashCommandPlugin skills={skills} />`
- `skills` comes from `useSkills()` called in `LexicalContentEditable` (same pattern as `useApp()`)

**Settings UI** (`ChatSection.tsx`)
- Add text input for "Skills vault folder" (vault-relative path, placeholder `Skills/`)

### Frontmatter Parsing

No `gray-matter`. Use a simple split:

```ts
function parseSkillFile(content: string): { description: string; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { description: '', body: content.trim() }
  const descMatch = match[1].match(/^description:\s*(.+)$/m)
  return {
    description: descMatch ? descMatch[1].trim() : '',
    body: match[2].trim(),
  }
}
```

## Implementation Phases

### 1. Foundation
- `src/settings/schema/setting.types.ts`: add `skillsVaultPath` to `chatOptions`
- `src/settings/schema/migrations/17_to_18.ts`: empty migration (version bump only)
- `src/settings/schema/migrations/index.ts`: register migration, bump `SETTINGS_SCHEMA_VERSION` to 18
- `src/components/settings/sections/ChatSection.tsx`: add "Skills vault folder" text input

### 2. Skills Loading
- `src/core/skills/skillsManager.ts`: `loadSkills()` with frontmatter parsing, merge logic
- `src/hooks/useSkills.ts`: React hook wrapping `loadSkills`, reactive via `useSettings()`

### 3. Unified Slash Plugin
- `src/components/chat-view/chat-input/plugins/template/SlashCommandPlugin.tsx`: unified plugin replacing `TemplatePlugin.tsx`
- Update `LexicalContentEditable.tsx`: swap `<TemplatePlugin />` for `<SlashCommandPlugin skills={skills} />`

### 4. Verify
- Skills from both sources appear in `/` dropdown alongside templates
- Selecting a skill replaces the trigger inline; surrounding text preserved
- Selecting a template replaces entire editor (unchanged behavior)
- Home dir skill overrides vault skill with same name
- Empty `skillsVaultPath` skips vault loading without error
- Missing `~/.claude/skills` skips without error

## Testing

- Unit: `loadSkills()` — home dir only, vault only, merge with collision, missing dirs, malformed frontmatter
- Unit: `parseSkillFile()` — with/without frontmatter, missing description field, empty body
- Integration: settings `skillsVaultPath` change → skills list refreshes
- Manual: type `/` → unified dropdown shows templates and skills; select skill → body inserted inline with surrounding text preserved; select template → full replace (existing behavior)

## Decisions

**Unified slash plugin**: A single `SlashCommandPlugin` handles both templates and skills. Avoids the dual-dropdown bug that would occur with two separate `LexicalTypeaheadMenuPlugin` instances (both render based on their own resolution state; Lexical command priority only affects key handling, not menu rendering).

**Inline replace, not append**: Skill body replaces the `/trigger` text node in-place. This lets users compose multi-skill messages naturally: `use /skill1 and /skill2 and summarize`. The surrounding text (including user-typed args/context) is preserved unchanged.

**Paragraph nodes per line**: `$createTextNode(body)` silently drops newlines. Splitting on `\n` and creating one `$createParagraphNode` per line matches how Lexical handles pasted multiline text.

**`---` regex over `gray-matter`**: `gray-matter` is not in this project's dependencies. Simple regex is sufficient for the two fields we need (`description` + body).

**Home dir takes precedence**: `~/.claude/skills` overrides vault skills on name collision. Rationale: user-global skills are more intentionally maintained; vault-local skills are project-specific and should be named distinctly.

## Edge Cases

**Home dir missing**: `fs.access()` check before `readdir()`. Skip silently.

**Vault path missing**: `app.vault.adapter.exists(path)` check. Skip silently.

**Invalid/missing frontmatter**: Treat entire file as body, `description: ""`.

**Name collision**: Home dir wins. `console.debug` logs the collision.

**No skills found**: Dropdown still appears for templates. If also no templates match, dropdown doesn't appear (existing behavior).

**Empty lines in body**: Create an empty `$createParagraphNode()` (no child text node) for blank lines.

## Success Metrics

- Skill files in `~/.claude/skills/*.md` appear in `/` autocomplete alongside templates
- Skill files in configured vault folder appear in `/` autocomplete
- Selecting a skill inserts its body inline; user-typed text around the trigger is preserved
- No error when either source directory is absent
- Template behavior is unchanged
