# Safe Cycle publisher on Windows: setup and testing

This guide runs the `sc-auto` publisher on your own Windows laptop, using your
home internet connection and a dedicated Google Chrome profile. It goes from a
fresh clone to a working **dry run**, then to running continuously. Nothing in
this guide posts to a social platform until the final "Going live" section.

Suggested location in the repo: `publisher/windows/README.md`.

All commands are for **PowerShell** (Start menu → type "PowerShell"). Do not
run it as Administrator unless a step says so.

---

## 0. Install the prerequisites (one time)

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Google.Chrome -e
```

Close and reopen PowerShell, then confirm:

```powershell
git --version
node --version   # must be v20 or newer
npm --version
```

If `npm` says "running scripts is disabled on this system", allow local
scripts for your account only:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## 1. Use a separate test database (important)

`sc-auto` uses workspace schema **4**; the production `sc` app uses schema
**3** and refuses to open a schema-4 workspace. Until `sc-auto` is pointed at a
separate **test** Supabase project (item P0 in `BLUEPRINT-local-windows.md`),
opening sc-auto's Studio or running the publisher against your real workspace
can upgrade it and break the production app.

Before continuing, confirm that `js/config.js` and the `connect-src` line in
`index.html` point to your test project, and that the SQL files in
`supabase/sql/` have been run on it in numeric order.

## 2. Clone the repository

Keep it **outside** OneDrive-synced folders (Desktop, Documents, Pictures are
often synced). The runner stores browser sessions there.

```powershell
cd C:\
mkdir dev -ErrorAction SilentlyContinue
cd C:\dev
git clone https://github.com/kalistamp/sc-auto.git
cd sc-auto
```

## 3. Run the Studio checks

```powershell
npm ci
npm run check
```

Every test should pass. If `npm run check` fails, stop here and fix it first.

## 4. Install and test the publisher

```powershell
cd publisher
npm ci
$env:SC_TEST_BROWSER_CHANNEL = "chrome"   # use your installed Chrome for tests
npm test
```

This runs the database, runner, browser (fixture pages only, never real
sites) and Automation-page tests. They must all pass.

If the browser tests can't find Chrome, install Playwright's own Chromium
instead and rerun:

```powershell
Remove-Item Env:SC_TEST_BROWSER_CHANNEL
npx playwright install chromium
npm test
```

## 5. Open Studio

Either use sc-auto's GitHub Pages site (repo **Settings → Pages → Deploy from
branch `main`, root**), or serve it locally from the repo root in a **second**
PowerShell window:

```powershell
cd C:\dev\sc-auto
py -m http.server 8000
```

Then open http://localhost:8000 and sign in. (`npm run serve` uses `python3`,
which usually doesn't exist on Windows; the blueprint replaces it.)

## 6. Create and protect the runner's local folder

Back in the first window, inside `C:\dev\sc-auto\publisher`:

```powershell
node cli.js init
icacls .local /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F"
notepad .local\config.json
```

In `config.json`, confirm these values for testing:

```json
"timezone": "America/Los_Angeles",
"browserChannel": "chrome",
"headless": false,
"live": false
```

Save and close. `.local` now holds everything private (sessions, tokens,
images, logs) and only your Windows account can read it.

## 7. Connect the runner to your workspace

```powershell
node cli.js auth
```

Enter the same email and password you use for Studio. The password is not
shown and not saved; only a refreshable session is stored in `.local`.

## 8. Sign in to each platform (one time)

Run this only for the platforms you plan to use. Each command opens a
separate, dedicated Chrome window. Sign in normally (including any 2FA), then
**close that Chrome window** to finish.

```powershell
node cli.js login facebook
node cli.js login reddit
node cli.js login nextdoor
```

This profile is separate from your everyday Chrome. Don't use it for anything
else, and don't run `login` while the runner is running.

## 9. Calibrate each platform (one time, never posts)

The runner will not guess which buttons to press. For each platform:

1. Find the exact page you post from (your Facebook Page, a specific
   subreddit's submit page, your Nextdoor business profile). Put that URL in
   `startUrl` in `config.json` **and** in Studio's Automation page ("Page the
   runner starts from"). They must match exactly.
2. Open the Playwright inspector:
   ```powershell
   node cli.js inspect facebook
   ```
   Use the inspector's "Pick locator" to capture exact locators for the
   compose button, text fields, final Publish button, the permalink, and the
   post body and author on a published post.
3. Copy the structure of `recipe.example.json` into `recipes.facebook` in
   `.local\config.json`, and fill in your locators.
4. Add a real, already-published post: `samplePermalink` (its link),
   `sampleBody` (its exact text), and `calibratedAt` (today's date).
5. Check it (read-only):
   ```powershell
   node cli.js validate facebook
   ```

Nextdoor also needs `"verifyAs": "author"` (or a second reader account); see
`publisher/README.md`, section "Calibrate each website once".

## 10. Set up automation in Studio

On Studio's **Automation** page:

- Keep **dry run** switched **on**.
- Turn on the platforms you calibrated.
- Add topics, one per line.
- In **Model settings**, switch on "The runner writes with this model too" so
  the runner uses the same AI provider and key.
- Set cadence so posts go out about once a week.

## 11. Dry-run test

One pass:

```powershell
node cli.js once
node cli.js status
```

Then run it continuously in the window for a few hours or a day:

```powershell
node cli.js run
```

Press **Ctrl+C** to stop. While it runs, the Automation page should show the
runner as online, and dry-run decisions should appear for due posts. Dry run
never opens a composer or clicks anything on a platform.

## 12. Optional: alerts when Studio is closed

- **Failure alerts:** create a Discord webhook (channel → Edit Channel →
  Integrations → Webhooks) and add `/slack` to the end of its URL.
- **Dead-man monitor:** create a free check at https://healthchecks.io with a
  5-minute period and 10-minute grace; copy its ping URL.

Save both for your account, then close and reopen PowerShell:

```powershell
[Environment]::SetEnvironmentVariable("SC_ALERT_WEBHOOK", "https://discord.com/api/webhooks/.../slack", "User")
[Environment]::SetEnvironmentVariable("SC_HEARTBEAT_WEBHOOK", "https://hc-ping.com/...", "User")
```

## 13. Keep the laptop awake

Plug it in, then (these only change the plugged-in settings):

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT
```

The screen may turn off and you may lock the laptop. Sleeping, hibernating or
**signing out** stops the runner. After a Windows Update restart, you must
sign in again before the runner restarts.

## 14. Run it in the background with Task Scheduler

Stop any `node cli.js run` window first. Then, inside
`C:\dev\sc-auto\publisher`:

```powershell
$dir  = (Get-Location).Path
$node = (Get-Command node).Source
$cmd  = "& '$node' cli.js run *>> '.local\runner.log'; exit `$LASTEXITCODE"
$action    = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -Command `"$cmd`"" -WorkingDirectory $dir
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "SafeCyclePublisher" -Action $action -Trigger $trigger -Settings $settings -Principal $principal
Start-ScheduledTask -TaskName "SafeCyclePublisher"
```

Watch the log:

```powershell
Get-Content .local\runner.log -Tail 20 -Wait
```

Everyday controls:

```powershell
Stop-ScheduledTask  -TaskName "SafeCyclePublisher"   # stop (do this before login/inspect)
Start-ScheduledTask -TaskName "SafeCyclePublisher"   # start
Unregister-ScheduledTask -TaskName "SafeCyclePublisher" -Confirm:$false   # remove
```

When a post is due in live mode, a Chrome window will appear briefly. Don't
close it or type in it.

(Once the blueprint's `publisher/windows/` scripts exist, `npm run win:install`
and `npm run win:uninstall` replace this section.)

## 15. Going live (only after a clean dry-run week)

1. Every platform you enabled passes `node cli.js validate <platform>`.
2. A week of dry-run shows the decisions you expect and nothing under
   **Needs you** that you haven't handled.
3. Set `"live": true` in `.local\config.json`, restart the task, and switch
   off dry run in Studio for **one** platform.
4. Schedule one post you have read word for word. Confirm it appears on the
   platform and in Studio with its link.
5. Enable the remaining platforms one at a time.

To stop all posting instantly, switch dry run back on in Studio.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Automation page says runner offline | Check the task is running and the laptop isn't asleep or signed out; read `.local\runner.log`. |
| "Another runner is using this browser profile" | Stop the task, confirm no `node` process remains (`Get-Process node`), try again. |
| A platform logged you out or shows a CAPTCHA | Stop the task, run `node cli.js login <platform>`, sign in, close Chrome, press **Resume posting** in Studio, start the task. |
| "Ambiguous browser locator; recalibration required" | The site changed. Stop the task, redo step 9 for that platform. |
| An attempt "may or may not have gone out" | Look at the account. Then use **Record what happened** in Studio, or `node cli.js reconcile ATTEMPT_ID <permalink>`. Never delete journal rows or profile files to retry. |
| `npm` scripts blocked | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. |

Full details on the posting safeguards, cadence and recovery are in
`publisher/README.md`.