# Safe Cycle Studio

Safe Cycle Studio is a private drafting, review, scheduling, and publication
record for Safe Cycle Tech social posts. It is a static GitHub Pages site with
an authenticated Supabase workspace.

## Storage and security

- Supabase Auth protects the sign-in screen.
- Workspace data lives in `sc.workspace_data` as one JSONB document per user.
- `sc.workspace_history` keeps restorable revisions.
- Row Level Security restricts both tables to the signed-in user.
- Browser writes use the version-checked `sc.save_workspace` RPC.
- Model-provider API keys remain in that browser's localStorage. They are never
  stored in Supabase or included in JSON backups.
- The Supabase URL and publishable key in `js/config.js` are public browser
  configuration. A service-role key must never be committed or sent to the
  browser.

## Local development

No build step is required.

```bash
npm run serve
```

Then open `http://localhost:8000`.

Run the complete checks before deployment:

```bash
npm run check
```

## Deployment

The repository is designed for GitHub Pages from the root of `main`.

```bash
git add index.html styles.css js package.json README.md tests
git commit -m "Update Safe Cycle Studio"
git push origin main
```

The `BUILD` value in `js/config.js` must match the stylesheet token, HTML body,
entry-point query, stylesheet query, and every local module in the import map.
The test suite enforces this to prevent mixed cached deployments.

## Data behavior

Edits are debounced and automatically saved. If another device updates the
same workspace first, the app presents a conflict choice instead of silently
overwriting either version. JSON exports remain complete portable backups.

Publishing stays manual: the application prepares copy and records publication
details but never posts to a social platform.
