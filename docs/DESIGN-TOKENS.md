# Design tokens — current visual language of `apps/web/src/style.css`

**Status:** transcription, not a token migration (Phase 0, PROD-006) · **Recorded:** 2026-10-09 · **Source:** `apps/web/src/style.css` @ `main` = `f242471` (unchanged by this PR)

This document captures the visual language **exactly as it exists today** so the Phase 1+ UI migration has an honest inventory of what is there. It is a reference sheet, not a commitment: **no CSS is changed by this PR, and no token migration is proposed or implied.** Everything below is transcribed from `apps/web/src/style.css`, which is a single minified line (6,760 bytes) — the values are the source of truth for current design debt and vocabulary.

**Already-known debt, verified by grep against the file:** there are **no CSS custom properties** (zero `var(--…)`), **no dark theme** (zero `prefers-color-scheme`), **no `:focus` styling** (zero matches — keyboard focus relies on browser defaults), **no motion** (zero `transition`/`animation`/`@keyframes`), **no `@font-face`** (the named webfonts are never loaded), and exactly **one `box-shadow`**. See §8.

## 1. Color palette — all 69 distinct hex values

Every hex value in the file, grouped by role. Counts are usages in the file (`#fff` appears 5×, `#fff0eb` 2×, `#e9eef2` 2×, `#76889c` 2×, all others once).

### 1.1 App surface (light theme)

| Hex | Used for |
|---|---|
| `#f4f7fa` | App background (`:root`) |
| `#fff` | Panels, header, metric cards, severity check surfaces (5 uses) |
| `#fbfcfe` | Task card background |
| `#f8fafc` | Header pill background |
| `#f1f7fa` | Info callout background |

### 1.2 Sidebar (dark surface)

| Hex | Used for |
|---|---|
| `#0d1b2c` | Sidebar background |
| `#20364d` | Selected nav item background |
| `#253f59` | Nav item hover background |
| `#30435a` | Sidebar-bottom divider |
| `#334963` | Environment pill border |

### 1.3 Text on the dark sidebar

| Hex | Used for |
|---|---|
| `#d0dceb` | Sidebar base text |
| `#c9d8e7` | Sidebar-bottom text |
| `#b5c9dd` | Nav item text |
| `#b9d4df` | Environment pill text |
| `#90a8c1` | Brand subtitle |
| `#8ea5bb` | Sidebar-bottom secondary span |
| `#7e94ac` | Nav section title |

### 1.4 Brand / accent (teal family)

| Hex | Used for |
|---|---|
| `#1dafa2` | Brand icon background |
| `#6eddd0` | Brand wordmark accent span |
| `#119789` | Eyebrow/kicker text |
| `#1bb6a5` | Accent rule (`.line`) |
| `#159d8f` | Hero symbol icon color |
| `#e2f5f2` | Hero symbol background |
| `#0d9989` | Text-button color |
| `#0e9b7b` | Active step number color |
| `#c1eae2` | Active step border |
| `#e9faf5` | Active step background |
| `#20aa9f` | Task card icon |
| `#62d6be` | Sidebar-bottom icon |
| `#4dd4ad` | Status/task dot |
| `#288fa1` | Info callout icon |

### 1.5 Text on light surfaces (darkest → lightest)

| Hex | Used for |
|---|---|
| `#18283b` | Root body text (`:root`) |
| `#22384d` | Incident-stat numbers |
| `#3a4d60` | Step titles |
| `#335e8e` | Avatar initials |
| `#60768c` | Panel body text |
| `#60748b` | Header pill text |
| `#72859a` | Hero lede |
| `#728899` | Task-card footer text |
| `#758ba0` | Table header text |
| `#76889c` | Metric labels, incident id (2 uses) |
| `#77889b` | Breadcrumb |
| `#8192a2` | Task card body |
| `#8294a7` | Incident stats |
| `#8799a8` | Task card top meta |
| `#8da0b0` | Note text |
| `#91a7ba` | Metric head icon |
| `#97a5b4` | Footer text |
| `#98a6b6` | Metric small text |
| `#99a9b8` | Step small text |
| `#9eb0bf` | `.muted` |
| `#a1b0bd` | Step number (idle) |
| `#acb9c5` | Breadcrumb separator |
| `#c4d0db` | Incident id separator |
| `#5b788e` | Info callout text |

### 1.6 Borders (light surfaces)

| Hex | Used for |
|---|---|
| `#e0e7ef` | Header bottom border |
| `#e0e7ee` | Panel/metric card border |
| `#e1e8f0` | Header pill border |
| `#e9eef2` | Divider, note top border (2 uses) |
| `#edf1f5` | Table row borders |
| `#e6edf2` | Task card footer border |
| `#e2eaf0` | Task card border |
| `#dde6ed` | Input border |
| `#dce5ed` | Step number border |

### 1.7 Status / severity

| Hex | Used for |
|---|---|
| `#fff0eb` | Severity badge and small-tag background (2 uses) |
| `#f9d6ca` | Severity badge border |
| `#c55030` | Severity badge text |
| `#9f513c` | Small-tag text |

### 1.8 Misc

| Hex | Used for |
|---|---|
| `#d9e9ff` | Avatar background |

## 2. Typography

| Token | Value | Where |
|---|---|---|
| Family — body | `'DM Sans', system-ui, sans-serif` | `:root` (no `@font-face` exists — renders as DM Sans only where installed, else system fallback) |
| Family — display | `'Space Grotesk', sans-serif` | `h1`, `h2`, `.metric-number`, `.brand strong` |
| Display 1 | 38px, letter-spacing −1.6px | `h1` (28px at ≤720px); browser-default bold (not overridden) |
| Metric number | 35px, weight 700 | `.metric-number` (27px at ≤720px) |
| Heading 2 | 20px, letter-spacing −0.5px | `h2`; browser-default bold |
| Brand title | 19px, letter-spacing −0.8px | `.brand strong` (Space Grotesk) |
| Stat number | 19px | `.incident-stats strong` (default bold) |
| Primary UI text | 13px | Nav buttons, breadcrumb, panel body, task titles (5 uses) |
| Secondary text | 12px | Meta labels, table cells (8 uses) |
| Small text | 11px | Pills, eyebrows, task body, step smalls (11 uses) |
| Micro text | 10px | Environment pill, dots-adjacent labels, footer (6 uses) |
| Weight 700 (explicit) | 6 uses | Eyebrow/kicker, severity badge, active step number, text button, metric number, avatar |
| Weight 600 | 1 use | Table headers (`th`) |
| Letter-spacing (positive) | 1px (2), 1.6px (1), 1.7px (1) | Severity/environment, eyebrow/kicker, nav section title |
| Letter-spacing (negative) | −0.5px, −0.8px, −1.6px | h2, brand, h1 |
| Line-height | 1.6 (2 uses), 1.8 (2 uses), 1.85 (1 use) | Hero lede/notes, task body/panel text, panel paragraph |

No `text-transform` exists — uppercase-looking labels are authored uppercase in markup.

## 3. Spacing (no scale exists)

There is no spacing scale — values are hand-set per rule. Inventories as they appear:

- **`gap`:** 6, 7, 9, 10, 12, 13, 14, 16, 17, 18, 20, 30 (px)
- **`padding`:** 0, 3, 4, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 24, 28, 40 (px); compound values: `28px 18px` (sidebar), `3px 8px 24px` (brand), `19px 9px 0` (sidebar-bottom), `0 40px` (header), `0 16px` (header ≤720px), `8px 11px` (pill), `7px 11px` (severity), `4px 7px` (small-tag), `13px 8px` (table cells), `22px 16px` (content ≤720px)
- **Representative `margin` rhythm:** `13px 0 6px` (h1), `9px 0` (h2), `24px 0` (divider), `19px`/`21px`/`23px`/`24px`/`28px`/`35px` vertical section spacing

The effective scale is nearly continuous over 3–40px — the structural debt a token migration would have to normalize (proposing the normalization is out of scope here).

## 4. Radii

| Value | Where |
|---|---|
| 4px | `.small-tag` |
| 5px | `.severity` |
| 7px | `.environment`, `.info`, text input (3 uses) |
| 8px | Sidebar nav buttons |
| 9px | `.task` cards |
| 10px | `.brand-icon` |
| 12px | `.metric`, `.panel` |
| 20px | `.hero-symbol` |
| 50% | `.avatar`, `.step-num`, status/task dots (3 uses) |
| 100px | Header `.pill` |

## 5. Shadows

Exactly one shadow in the file:

```css
box-shadow: 0 5px 24px rgba(12,32,53,.025); /* .metric, .panel */
```

All other elevation is 1px borders (§1.6).

## 6. Layout dimensions and responsive behavior

| Token | Value | Where |
|---|---|---|
| Sidebar width | 260px (100% at ≤720px) | `.sidebar` |
| Header height | 76px (56px at ≤720px) | `header` |
| Content max-width | 1440px, padding 40px (22px 16px at ≤720px) | `.content` |
| Brand icon | 42px | `.brand-icon` |
| Avatar | 34px | `.avatar` |
| Step number | 31px | `.step-num` |
| Hero symbol | 78px (hidden at ≤720px) | `.hero-symbol` |
| Table scroll box | max-height 440px, `overflow-x: auto` | `.table-wrap` (the horizontal-overflow containment for tables) |
| Text input | min-width 170px | `.section-heading input` |
| Metrics grid | 4 columns → 2 at ≤1100px | `.metrics` (gap 18px, 9px at ≤720px) |
| Two-column grid | `1.3fr 1fr` → `1fr` at ≤1100px | `.two-col` |
| Task grid | 3 → 2 at ≤1100px → 1 at ≤720px | `.task-grid` |

Breakpoints: **1100px** and **720px** — the only two media queries. No `prefers-*` queries exist.

## 7. Light/dark guidance (what today's file supports)

- **The file defines a single light theme.** The dark contrast in the UI comes from the sidebar surface (`#0d1b2c`, text `#d0dceb`) against the light app background (`#f4f7fa`, text `#18283b`) — both spot-checked at 12.49:1 and 13.90:1 WCAG contrast respectively.
- **A dark theme cannot be derived from this file today** — with zero custom properties, every hex is hardcoded per rule. Introducing theme tokens (variables + a dark value set) is Phase 1+ migration work; this transcription deliberately proposes none.
- **Contrast is not at the Blueprint §4 WCAG 2.2 AA target everywhere.** Spot-computed pairs (WCAG 2.x relative luminance): `.muted` `#9eb0bf` on `#fff` = **2.23:1**, metric small `#98a6b6` on `#fff` = **2.48:1**, footer `#97a5b4` on `#f4f7fa` = **2.34:1**, task footer `#728899` on `#fbfcfe` = **3.59:1** — all below the 4.5:1 normal-text threshold. Highest-contrast pairs pass comfortably (body text 13.90:1, stat numbers 12.06:1). A full contrast audit belongs to the Phase 1 token work; listed here as debt the current palette carries.
- **Keyboard focus and reduced motion:** the Blueprint §4 standards require visible keyboard focus and reduced-motion support. Today there are no `:focus` rules and no motion at all (§8) — focus relies on browser defaults and reduced-motion is trivially satisfied only because nothing animates. Both must be designed in as the UI gains interactivity.

## 8. Verification greps (run this session against the file @ `f242471`)

```text
var(-- custom properties):       0
prefers-color-scheme:            0
prefers-reduced-motion:          0
:focus:                          0
transition|animation|@keyframes: 0
text-transform:                  0
@font-face:                      0
z-index:                         0
box-shadow:                      1
```
