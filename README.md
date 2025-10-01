# 📅 Google Calendar Course Sync

A Node.js tool that lets you **subscribe to specific courses** from a shared Google Calendar and keep them synced into your own personal calendar.

It supports:
- 🔑 OAuth2 + refresh tokens (per user)
- 🎯 Filtering by keywords or regex
- 🔄 Incremental sync + backfill
- 🧹 Automatic cleanup (stale events, duplicates, recurring masters)
- 👥 Multiple users & multiple subscriptions

---

## 🚀 Quick Start

### 1. Install
```bash
git clone https://github.com/AcePeaX/gcalendar-filter-sync.git
cd google-calendar-course
npm install
````

### 2. Configure `.env`

Create a `.env` file with:

```env
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=yyy
GOOGLE_REDIRECT_URI=http://localhost:5173/oauth2/callback

DB_PATH=./sync.db
TOKENSTORE_DIR=./secure_tokens

# optional
LOG_LEVEL=info
BACKFILL_AHEAD_DAYS=180   # days forward for backfill
BACKFILL_BEHIND_DAYS=7    # days backward for backfill
```

👉 You can find calendar IDs in Google Calendar:

* Go to **Settings → Integrate calendar → Calendar ID**

---

## 🔑 Authentication

1. Run login to generate an auth URL:

   ```bash
   npm run login
   ```

   Copy the URL, open it, authorize access, and copy the `?code=...` value from the redirect.

2. Store tokens interactively:

   ```bash
   npm run connect
   ```

   You’ll be prompted for:

   * `Enter your code:` → paste the code from step 1
   * `Enter the profile id:` → choose an ID for this user (e.g. `acepeax`)

🔒 Tokens are saved encrypted in `secure_tokens/`.

---

## 📚 Subscriptions

Each **subscription** links:

* **profile (token key)**: user who authorized access
* **source calendar ID**: the “all courses” calendar
* **target calendar ID**: your personal or dedicated calendar
* **filters**: keywords or regex to match courses

### Add

```bash
npm run addsub -- <PROFILE_ID> <SOURCE_CAL_ID> <TARGET_CAL_ID> "Course A" "Course B"
```

Example:

```bash
npm run addsub -- acepeax c65606a9c7@group.calendar.google.com my.email@gmail.com \
  "Optimal transport for machine learning - G.Peyré" \
  "Convex optimization A.d'Aspremont"
```

### List

```bash
npm run list
```

### Update filters

Interactive:

```bash
npm run update
```

Direct (replace filters):

```bash
npm run update -- <SUB_ID> "New Course A" "New Course B"
```

Append filters:

```bash
npm run update -- <SUB_ID> --append "Extra Course"
```

Regex filter:

```bash
npm run update -- <SUB_ID> --regex "(Transport|Optimization)"
```

Force resync (wipe mappings + re-populate on next worker run):

```bash
npm run update -- <SUB_ID> --resync "Course A"
```

### Delete

Interactive:

```bash
npm run delete
```

Direct:

```bash
npm run delete -- <SUB_ID>
```

---

## 🔄 Sync Worker

Run the worker to sync all enabled subscriptions:

```bash
npm run worker
```

👉 Run it in a cron job to keep calendars updated:

```cron
*/15 * * * * cd /home/user/google-calendar-course && npm run worker >> sync.log 2>&1
```

---

## 📂 Scripts

| Command           | Description                                    |
| ----------------- | ---------------------------------------------- |
| `npm run login`   | Generate OAuth2 URL for login                  |
| `npm run connect` | Enter auth code + profile ID to save tokens    |
| `npm run migrate` | Run DB migrations                              |
| `npm run addsub`  | Add a subscription (argv mode)                 |
| `npm run list`    | List all subscriptions                         |
| `npm run update`  | Update subscription filters (interactive/argv) |
| `npm run delete`  | Delete a subscription (interactive/argv)       |
| `npm run worker`  | Sync worker (processes all enabled subs)       |

---

## ⚙️ How it Works

* Uses **Google Calendar incremental sync tokens** for efficiency.
* Expands recurring events into **instances only** (avoids duplicates).
* Maintains `event_mappings` in SQLite so updates apply cleanly.
* Periodically **backfills** a time window to catch new filters.
* Prunes stale events and deduplicates target calendars.

---

## ✅ Example Flow

1. Login and save tokens:

   ```bash
   npm run login
   npm run connect
   ```

2. Create a dedicated Google Calendar (e.g. `Subscribed Courses`) and copy its ID.

3. Add a subscription:

   ```bash
   npm run addsub -- acepeax <source-calendar-id> <subscribed-calendar-id> "Machine Learning" "Convex Optimization"
   ```

4. Test sync:

   ```bash
   npm run worker
   ```

5. Schedule it with cron.

---

## 🔒 Security

* Tokens are encrypted and stored under `secure_tokens/`.
* File permissions restricted (`chmod 600`).
* Each user has a separate profile ID.

---

## 📜 License

This project is licensed under the Apache 2.0 License.

You are free to use, modify, and distribute this code in your own projects, **provided you include attribution**:

```
© 2025 AcePeaX
Original project: https://github.com/AcePeaX/gcalendar-filter-sync
Licensed under Apache License 2.0
```