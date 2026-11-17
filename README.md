# Inspect AI

Inspect AI is a student prototype for reviewing visible details on packaged product labels. It does not certify legal compliance and is not an official service.

## Run locally

Create a Supabase project, enable email authentication, and copy its project URL and publishable key (or legacy anon key). Copy `.env.example` to `.env` and fill in the values:

```powershell
Copy-Item .env.example .env
```

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env` (or use `VITE_SUPABASE_ANON_KEY` for a legacy anon key), then run these commands from the project folder:

```powershell
npm install
npm run dev
```

Open the local URL printed by Vite, usually <http://localhost:5173>.

## Work offline

The production build is an installable web app. Run `npm run build` and `npm run preview`, then open the preview URL once while online so the browser can cache the app. Offline use requires a browser that supports service workers and a secure context (HTTPS or localhost). The Vite development server does not enable offline caching.

After the app has been cached, choose **Continue in offline mode** if you are not signed in. Scans and scan history are stored only in this browser and remain available offline; Supabase sign-in and account creation require an internet connection. Camera scanning still depends on browser camera permission, while QR scanning from an image works offline.

On-device OCR works offline after it has been run once online to download and cache the English language data. Keep the app open until the first OCR run finishes.

## What the prototype can do

- Verify email and password with Supabase Auth and create accounts.
- Upload, preview, replace, or remove a label image.
- Scan a QR code with the camera or choose an image containing a QR code.
- Analyze label photos with on-device English OCR and best-effort field extraction.
- Edit extracted label details and run simple preliminary checks.
- Save, reopen, and delete scans in this browser using IndexedDB.

Choosing **Analyze label** runs OCR on the uploaded photo in the browser and estimates label fields from the text it recognizes. The OCR engine and English language data may be downloaded the first time analysis is used. Label images are not uploaded to an analysis service. OCR may misread text, and field extraction is only a best-effort estimate.

QR scanning uses the browser camera when permission is granted, or can read a QR code from an image. The decoded contents are displayed as text and are never opened automatically. QR contents do not verify product details or legal compliance.

Authentication is handled by Supabase. The client-side publishable/anon key is intended for browser use; never put a Supabase `service_role` secret in this app. Keep Row Level Security enabled for any Supabase database tables you add. Scans are currently stored in this browser, not in Supabase, and are not synced between devices or accounts. Configure email confirmation and allowed redirect URLs in your Supabase project if you want to require verified email addresses.

## Important

Statuses are based on whether text was detected and on simple format checks. They are not a rule-by-rule legal assessment. Requirements may depend on the product and circumstances, and must be verified by a person against reliable, current sources before anyone relies on the results.
