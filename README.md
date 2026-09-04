# Drive Duplicate File Cleaner

A small, static, client-side-only web app that finds duplicate files across
your entire Google Drive — photos, videos, PDFs, and other documents — and
lets you review and move them to Trash. It's plain HTML/CSS/JS with no build
step and no backend server — it talks to the Google Drive API directly from
your browser using your own OAuth credentials. Nothing you scan or delete
ever passes through a third-party server.

**Safety first:** the app never permanently deletes anything. Files you
choose to remove are moved to your Google Drive **Trash**, exactly like
deleting them from drive.google.com, so you can restore them until the Trash
is emptied.

## How duplicate detection works

The app scans your whole Drive and groups files by Drive's `md5Checksum`
(the content hash Drive computes for every uploaded file). Only files that
are byte-for-byte identical end up in the same group — this avoids false
positives from similar-but-different files. Results are organized into
**Photos, Videos, PDFs, Docs, and Others** tabs so you can review one
category at a time, and each file shows its Drive folder path so you know
exactly where it lives.

Within each group, the oldest file (by creation time) is kept by default;
you can switch the default rule to "keep newest", override which copy to
keep on a per-group basis, or fine-tune the exact files to delete with
per-file checkboxes. You can delete a single file immediately, or select
files across groups and delete them all at once.

Native Google Docs, Sheets, and Slides don't have a content checksum (they
aren't stored as flat files), so they're not included in duplicate
detection — this is a Drive API limitation, not a setting.

## For end users

Just open the deployed app and click **Sign in with Google** — a default
Client ID is already configured. If you'd rather use your own OAuth Client
ID (e.g. so Drive access runs under your own Google Cloud project), open
**Settings** and paste it in; it's stored only in your browser's
`localStorage`.

## 1. Create a Google OAuth Client ID (one-time developer setup)

If you're deploying your own copy of this app, you need your own OAuth
Client ID so the app can ask Google, on your users' behalf, for permission to
read and manage their Drive files. This is free and takes a few minutes, and
only needs to be done once by whoever deploys the app — end users never see
or configure this.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create a new project (or pick an existing one).
2. Open **APIs & Services → Library**, search for **Google Drive API**, and
   click **Enable**.
3. Open **APIs & Services → OAuth consent screen**.
   - Choose **External** (unless you have a Google Workspace org).
   - Fill in the required app name/support email fields.
   - Under **Scopes**, you don't need to add anything here — the app requests
     the Drive scope at sign-in time.
   - Under **Test users**, add your own Google account email while the app is
     in "Testing" mode (this is fine for personal use; you don't need to
     publish the app).
4. Open **APIs & Services → Credentials → Create Credentials → OAuth client
   ID**.
   - Application type: **Web application**.
   - Under **Authorized JavaScript origins**, add the URL(s) you'll open the
     app from, for example:
     - `https://<your-github-username>.github.io` (for GitHub Pages)
     - `http://localhost:8080` (if you run it locally)
   - Click **Create** and copy the generated **Client ID**
     (looks like `xxxxxxxxxx-xxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com`).

## 2. Configure the app

1. Open `app.js` and set `DEFAULT_CLIENT_ID` to the Client ID you created
   above.
2. Deploy (or open `index.html` locally). Users just click
   **Sign in with Google** and grant Drive access, or open **Settings** to
   override the Client ID with their own.

## 3. Scan and clean up

1. Click **Scan for duplicate files**. By default, only files you own are
   scanned; check **Include shared drives** if you also want to scan shared
   drives you have access to. The whole Drive is scanned — not just photos.
2. Use the category tabs (**All / Photos / Videos / PDFs / Docs / Others**)
   to focus on one file type at a time.
3. Review each duplicate group. The kept copy is highlighted; every other
   copy is pre-selected for deletion. Click **keep this** on any tile to
   change which copy is kept, or use the per-file checkboxes to fine-tune
   your selection. Use the **Keep** dropdown + **Apply & select rest** to
   switch the default rule between oldest/newest across all groups.
4. Click **delete now** on any individual file tile to trash just that one
   file immediately, or select multiple files and click **Move N files to
   Trash** to delete them in bulk. Either way you'll be asked to confirm
   first, and can restore anything from
   [Drive Trash](https://drive.google.com/drive/trash) until it's emptied.

## Running locally

No build tools are required — it's static files.

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

Make sure `http://localhost:8080` (or whichever port you use) is added under
**Authorized JavaScript origins** for your OAuth Client ID.

## Deploying to GitHub Pages

This repo includes a workflow at `.github/workflows/deploy-pages.yml` that
publishes the site with GitHub Pages on every push to `main`.

1. In your repository, go to **Settings → Pages** and set **Source** to
   **GitHub Actions**.
2. Push to `main` (or run the workflow manually from the **Actions** tab).
3. Your app will be available at `https://<your-github-username>.github.io/<repo-name>/`.
4. Add that exact URL to your OAuth Client ID's **Authorized JavaScript
   origins** (see step 1 above).

## Permissions requested

The app requests the `https://www.googleapis.com/auth/drive` OAuth scope.
This broad scope is required because the app needs to read metadata for
existing files across your whole Drive (not just files it created itself),
resolve folder names to show file paths, and move duplicates to Trash. You
can revoke access at any time from your
[Google Account permissions page](https://myaccount.google.com/permissions),
or by clicking **Sign out** in the app.

## Project structure

```
index.html   Markup and layout
styles.css   Styling (light/dark aware)
app.js       All app logic: auth, Drive API calls, duplicate grouping, UI
.github/workflows/deploy-pages.yml   GitHub Pages deployment
```
