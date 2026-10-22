# Weekly Chore Chart – GitHub Pages + Firebase (plain JSON database)

No SQL. Your data is one JSON tree in Firebase Realtime Database, shared live by all devices.
Admin tools can download a full **JSON backup** (restorable) and an **Excel (.xlsx)** report.

```
index.html            page            styles.css   design
app.js                app logic       config.js    your Firebase web-app config (public identifiers)
database.rules.json   security rules  starter-data.json   initial JSON (chores, members, settings)
```

## How the data looks (JSON)
```
settings     { rateCents: 2000, startPoints: -10, weekId: "w1", weekStart: "2026-10-19", ... }
members      { m1: {name, quota}, ... m5 }
tasks        { t01: {name, kind: "regular"|"paid", points, max, active, claim: {member, week}} ... }
completions  { "w1_t24_s1": {member, task, kind, minutes, rateCents, paymentCents, at, ...} }
```
`rateCents` / `paymentCents` are whole cents (2000 = $20.00). Every paid completion stores the rate it used,
so changing the hourly rate never alters old earnings.

## Step 1 – Create the Firebase project (free "Spark" plan)
1. https://console.firebase.google.com → **Add project** (Google Analytics can be off).
2. **Build → Realtime Database → Create database** → pick a location → **Start in locked mode**.

## Step 2 – Load the starter data
Realtime Database → **Data** tab → ⋮ menu → **Import JSON** → choose `starter-data.json` (at the root).

## Step 3 – Paste the security rules
Realtime Database → **Rules** tab → replace everything with the contents of `database.rules.json` → **Publish**.
(Use the Rules Playground there to try it: an unauthenticated write to `/settings/rateCents` must be denied.)

## Step 4 – Connect the page
1. Project settings (gear) → **Your apps → </> Web** → register an app → copy the `firebaseConfig` values.
2. Paste them into `config.js`. These values are public identifiers, not secrets.

## Step 5 – Create the admin login
1. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable.**
2. Authentication → **Users → Add user** (your email + a long password).
3. Copy that user's **User UID**. In Realtime Database → Data, add a child at the root:
   `admins` → `<that UID>` = `true`  (only the console can write this; the rules block everyone else).
4. Authentication → Settings → **Authorized domains → Add** `YOUR-USERNAME.github.io`.

Anyone can technically create a Firebase Auth account, but without their UID listed under `admins` it has **no** extra rights.

## Step 6 – Publish on GitHub Pages
Create a repo, upload all files (you do not need to upload `starter-data.json`), then
**Settings → Pages → Deploy from a branch → main / (root)**. Your site: `https://YOUR-USERNAME.github.io/REPO/`.
To update later, commit the changed files.

## Step 7 – Test sharing
Open the site on two devices. Pick different names. Claim and tick a chore on one: the other updates in ~1 second
(header shows **● Live**). Complete a paid job (e.g. 45 min → $15.00). Admin → Settings → change the rate: older
records keep their old rate. Admin → Summary → download Excel and JSON.

## Backups
* Admin → Summary → **⬇ Backup (.json)**: full copy; **⬆ Restore backup** puts it back (a safety copy downloads first).
* Admin → Summary → **⬇ Excel (.xlsx)**: sheets Summary, Paid earnings, Paid history, All records, Chores.
  Anyone can also download the *Paid earnings* workbook from the Paid tab.
* The app nudges you if no backup was downloaded on that device for 7+ days.
* Firebase console can also export the whole database as JSON (Data tab → ⋮ → Export JSON).

## How it is protected
* Everyone can **read** the data (so devices stay in sync). Nobody can change settings, chores, members, voids or
  edits unless signed in with the admin account listed under `admins`.
* Household members (no login) can only: claim/release a chore, create one completion for a chore claimed by that
  member (rules check the week, task, points, hourly rate and payment maths), and delete their own regular chore this week.
* A completion's key is `week_task_slot`; the rules allow creating it only if it does not exist, so double-clicks and
  simultaneous taps cannot create duplicates or exceed the weekly limit.
* Password handling, lockouts and sessions are done by Firebase Authentication. The admin session ends when the tab closes.

## Limitations
* **Members are not authenticated.** Anyone with the link can choose any name and complete chores as that person.
  This is the price of "simple". Keep the link within the household, and use Admin → Records to fix mistakes.
* The page and data are readable by anyone who finds the URL.
* The Spark plan allows 100 simultaneous connections and 1 GB — far more than five people need.
* A new week starts automatically (if enabled) when the first device opens the page after the reset day.
* Changes are only shown as saved after Firebase confirms; if the phone is offline, the app says "NOT saved".
