# Safe Cycle Studio

Safe Cycle Studio is a private drafting, review, scheduling, and publication
record for Safe Cycle Tech social posts. It is a static GitHub Pages site with
an authenticated Supabase workspace.

## Storage and security

- Supabase Auth protects the sign-in screen.
- Workspace metadata, posts, deleted posts, model runs, and activity live as
  separate rows in `sc.workspace_items`.
- `sc.workspace_sync_state` is a small revision signal; Realtime sends that
  signal and clients fetch only changed rows.
- `sc.workspace_item_versions` keeps a bounded set of restorable delta
  revisions. Legacy JSONB data remains intact for rollback and old history.
- Row Level Security and authenticated RPCs restrict every row to its owner.
- The browser cache uses row-level IndexedDB records instead of repeatedly
  serializing the complete workspace into localStorage.
- Model-provider API keys remain in that browser's localStorage. They are never
  stored in Supabase or included in JSON backups.
- The Supabase URL and publishable key in `js/config.js` are public browser
  configuration. A service-role key must never be committed or sent to the
  browser.

Before deploying this build, run the two manual SQL Editor files in the local
`prelaunch_deployment/sc` package in numeric order. Do not use a Supabase config
push or database push for this project.

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

Edits are debounced and automatically saved as row deltas. Keystrokes in a
post stage only that post. If another device updates the same workspace first,
the app presents a conflict choice instead of silently overwriting either
version. JSON exports remain complete portable backups.

Publishing stays manual: the application prepares copy and records publication
details but never posts to a social platform.
