import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent, type ReactNode } from "react";
import type { BrowserQRCodeReader, IScannerControls } from "@zxing/browser";
import { supabase, supabaseConfigError } from "./supabase";

type FieldKey =
  | "productName"
  | "manufacturer"
  | "netQuantity"
  | "date"
  | "mrp"
  | "consumerCare"
  | "unitSalePrice";
type FieldValues = Record<FieldKey, string>;
type FieldStatuses = Record<FieldKey, CheckStatus>;
type CheckStatus = "Found" | "Needs review" | "Not detected" | "Needs rule verification";
type Screen = "login" | "dashboard" | "history" | "scan" | "qr" | "results";

interface ScanRecord {
  id: string;
  image: string;
  imageName: string;
  createdAt: string;
  analyzedAt: string | null;
  source: "Demo" | "On-device OCR";
  fields: FieldValues;
  statuses: FieldStatuses;
  rawOcrText: string;
}

const DATABASE_NAME = "inspect-ai";
const STORE_NAME = "scans";

const FIELD_DETAILS: { key: FieldKey; label: string; hint: string }[] = [
  { key: "productName", label: "Product name", hint: "Name shown on the package" },
  { key: "manufacturer", label: "Manufacturer / packer / importer", hint: "As printed on the package" },
  { key: "netQuantity", label: "Net quantity", hint: "For example, 500 g or 1 L" },
  { key: "date", label: "Date / best-before declaration", hint: "Enter the wording visible on the package" },
  { key: "mrp", label: "Maximum retail price (MRP)", hint: "Enter the price and any visible tax wording" },
  { key: "consumerCare", label: "Consumer care details", hint: "For example, a phone number, email, or address" },
  { key: "unitSalePrice", label: "Unit sale price (where applicable)", hint: "Applicability needs to be verified for the product" },
];

const EMPTY_FIELDS: FieldValues = {
  productName: "",
  manufacturer: "",
  netQuantity: "",
  date: "",
  mrp: "",
  consumerCare: "",
  unitSalePrice: "",
};

const EMPTY_STATUSES: FieldStatuses = {
  productName: "Not detected",
  manufacturer: "Not detected",
  netQuantity: "Not detected",
  date: "Not detected",
  mrp: "Not detected",
  consumerCare: "Not detected",
  unitSalePrice: "Needs rule verification",
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open browser storage."));
  });
}

async function getSavedScans(): Promise<ScanRecord[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve((request.result as ScanRecord[]).sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt),
    ));
    request.onerror = () => reject(request.error ?? new Error("Could not read saved scans."));
  });
}

async function saveScan(scan: ScanRecord): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(scan);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save this scan."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Saving this scan was interrupted."));
  });
}

async function removeSavedScan(id: string): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not delete this scan."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Deleting this scan was interrupted."));
  });
}

function checkFields(fields: FieldValues): FieldStatuses {
  const hasText = (key: FieldKey) => fields[key].trim().length > 0;
  return {
    productName: hasText("productName") ? "Found" : "Not detected",
    manufacturer: hasText("manufacturer") ? "Found" : "Not detected",
    netQuantity: !hasText("netQuantity")
      ? "Not detected"
      : /\d/.test(fields.netQuantity) && /[a-z]/i.test(fields.netQuantity)
        ? "Found"
        : "Needs review",
    date: hasText("date") ? "Found" : "Not detected",
    mrp: !hasText("mrp")
      ? "Not detected"
      : /\d/.test(fields.mrp)
        ? "Found"
        : "Needs review",
    consumerCare: !hasText("consumerCare")
      ? "Not detected"
      : /(?:\+?\d[\d\s()-]{6,}\d|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i.test(fields.consumerCare)
        ? "Found"
        : "Needs review",
    unitSalePrice: !hasText("unitSalePrice")
      ? "Needs rule verification"
      : /\d/.test(fields.unitSalePrice)
        ? "Found"
        : "Needs review",
  };
}

function parseOcrText(text: string): FieldValues {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lineMatching = (pattern: RegExp) => lines.find((line) => pattern.test(line)) ?? "";
  const manufacturer = lineMatching(/\b(manufactured|marketed|packed|imported)\s+by\b/i);
  const quantityLine = lineMatching(/\bnet\s*(?:qty|quantity|wt|weight)?\b/i);
  const quantity = quantityLine.match(/\d+(?:\.\d+)?\s?(?:kg|g|mg|ml|l|litres?|liters?|pcs|pieces|count)\b/i)
    ?? text.match(/\b\d+(?:\.\d+)?\s?(?:kg|g|mg|ml|litres?|liters?)\b/i);
  const date = lineMatching(/\b(mfg|manufactur(?:e|ed|ing)|packed|best\s*before|use\s*by|expiry|exp\.?)\b/i);
  const mrp = lineMatching(/\bmrp\b/i);
  const care = lineMatching(/\b(customer|consumer)\s*care|contact|helpline|e-?mail|email\b/i);
  const unitSalePrice = lineMatching(/\bunit\s*(?:sale\s*)?price\b/i);
  const productName = lines.find((line) =>
    line.length < 100 && !/\b(mrp|mfg|manufactur|packed|best before|expiry|net qty|customer care|consumer care)\b/i.test(line),
  ) ?? "";

  return {
    productName,
    manufacturer,
    netQuantity: quantity?.[0] ?? "",
    date,
    mrp,
    consumerCare: care,
    unitSalePrice,
  };
}

function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const maxSide = 1400;
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      URL.revokeObjectURL(objectUrl);
      if (!context) {
        reject(new Error("Your browser could not prepare this image."));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.8));
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("This image could not be opened. Try another image file."));
    };
    image.src = objectUrl;
  });
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    history: <><path d="M3 12a9 9 0 1 0 2.64-6.36L3 8" /><path d="M3 3v5h5m4-1v5l3 2" /></>,
    scan: <><path d="M4 7V5a1 1 0 0 1 1-1h2m10 0h2a1 1 0 0 1 1 1v2M4 17v2a1 1 0 0 0 1 1h2m10 0h2a1 1 0 0 0 1-1v-2M4 12h16" /><path d="M8 9v6m4-6v6m4-6v6" /></>,
    qr: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zm5 0h2m-7 5v2m5-5v5h2" /></>,
    upload: <><path d="M12 16V4m-4 4 4-4 4 4" /><path d="M20 16v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-3" /></>,
    close: <><path d="m18 6-12 12M6 6l12 12" /></>,
    back: <><path d="m15 18-6-6 6-6" /><path d="M20 12H9" /></>,
    trash: <><path d="M3 6h18m-2 0-.9 14H5.9L5 6m4 0V4h6v2m-5 4v6m4-6v6" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    photo: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m21 15-5-5L5 20" /></>,
    sparkle: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /><path d="m19 14 1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1 1-2.5Z" /></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
  };
  return (
    <svg aria-hidden="true" className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths[name] ?? paths.grid}
    </svg>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") {
    return cause.message;
  }
  return "Unknown error";
}

function newScan(): ScanRecord {
  return {
    id: crypto.randomUUID(),
    image: "",
    imageName: "",
    createdAt: new Date().toISOString(),
    analyzedAt: null,
    source: "Demo",
    fields: { ...EMPTY_FIELDS },
    statuses: { ...EMPTY_STATUSES },
    rawOcrText: "",
  };
}

function App() {
  const [screen, setScreen] = useState<Screen>("login");
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [active, setActive] = useState<ScanRecord | null>(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const [accountEmail, setAccountEmail] = useState("");
  const [offlineMode, setOfflineMode] = useState(false);
  const [authMode, setAuthMode] = useState<"signIn" | "signUp">("signIn");
  const [authMessage, setAuthMessage] = useState("");
  const [authError, setAuthError] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [offlineSupportError, setOfflineSupportError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [ocrProgress, setOcrProgress] = useState("");
  const [dragging, setDragging] = useState(false);
  const [showOcrText, setShowOcrText] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const qrImageInput = useRef<HTMLInputElement>(null);
  const qrVideo = useRef<HTMLVideoElement>(null);
  const qrReader = useRef<BrowserQRCodeReader | null>(null);
  const qrControls = useRef<IScannerControls | null>(null);
  const [qrStatus, setQrStatus] = useState<"idle" | "starting" | "scanning">("idle");
  const [qrText, setQrText] = useState("");
  const [qrError, setQrError] = useState("");

  useEffect(() => {
    const updateConnection = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", updateConnection);
    window.addEventListener("offline", updateConnection);
    return () => {
      window.removeEventListener("online", updateConnection);
      window.removeEventListener("offline", updateConnection);
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    if (!("serviceWorker" in navigator)) {
      setOfflineSupportError("This browser does not support offline app caching.");
      return;
    }

    const appBase = new URL(import.meta.env.BASE_URL, window.location.href);
    const serviceWorkerUrl = new URL("sw.js", appBase);
    navigator.serviceWorker.register(serviceWorkerUrl, { scope: appBase.pathname }).catch((cause: unknown) => {
      setOfflineSupportError(`Could not enable offline app caching: ${cause instanceof Error ? cause.message : "check your browser settings."}`);
    });
  }, []);

  useEffect(() => {
    if (screen !== "login") return;
    setCurrentTime(new Date());
    const timer = window.setInterval(() => setCurrentTime(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, [screen]);

  useEffect(() => {
    getSavedScans().then((saved) => {
      setScans((current) => {
        const merged = new Map(saved.map((scan) => [scan.id, scan]));
        current.forEach((scan) => merged.set(scan.id, scan));
        return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      });
    }).catch((cause: unknown) => {
      setError(`Could not load saved scans: ${cause instanceof Error ? cause.message : "browser storage is unavailable."}`);
    });
  }, []);

  useEffect(() => {
    if (offlineMode) {
      setAccountEmail("Offline mode");
      setScreen("dashboard");
      setAuthReady(true);
      return;
    }
    if (!supabase) {
      setAuthReady(true);
      return;
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setAccountEmail(session?.user.email ?? "");
      setScreen(session ? "dashboard" : "login");
      setAuthReady(true);
    });

    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (sessionError) setAuthError(`Could not restore your sign-in: ${sessionError.message}`);
      setAccountEmail(data.session?.user.email ?? "");
      setScreen(data.session ? "dashboard" : "login");
      setAuthReady(true);
    }).catch((cause: unknown) => {
      setAuthError(`Could not restore your sign-in: ${cause instanceof Error ? cause.message : "please try again."}`);
      setAuthReady(true);
    });

    return () => subscription.unsubscribe();
  }, [offlineMode]);

  useEffect(() => {
    if (screen !== "qr") {
      qrControls.current?.stop();
      qrControls.current = null;
      qrReader.current = null;
      setQrStatus("idle");
    }
  }, [screen]);

  const persistScan = (scan: ScanRecord) => {
    setScans((current) => [scan, ...current.filter((item) => item.id !== scan.id)].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt),
    ));
    void saveScan(scan).catch((cause: unknown) => {
      setError(`Could not save this scan: ${cause instanceof Error ? cause.message : "browser storage is unavailable."}`);
    });
  };

  const beginScan = () => {
    setError("");
    setActive(newScan());
    setScreen("scan");
  };

  const openScan = (scan: ScanRecord) => {
    setError("");
    setActive(scan);
    setShowOcrText(false);
    setScreen("results");
  };

  const updateActive = (patch: Partial<ScanRecord>) => {
    if (!active) return;
    const updated = { ...active, ...patch };
    setActive(updated);
    if (updated.analyzedAt) persistScan(updated);
  };

  const handleFile = async (file?: File) => {
    if (!file || !active) return;
    setError("");
    if (!file.type.startsWith("image/")) {
      setError("Choose an image file such as JPG, PNG, or WebP.");
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      setError("This image is larger than 12 MB. Choose a smaller image and try again.");
      return;
    }
    setLoading(true);
    try {
      const image = await compressImage(file);
      updateActive({
        image,
        imageName: file.name,
        analyzedAt: null,
        fields: { ...EMPTY_FIELDS },
        statuses: { ...EMPTY_STATUSES },
        rawOcrText: "",
        source: "Demo",
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the selected image.");
    } finally {
      setLoading(false);
    }
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    void handleFile(event.target.files?.[0]);
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void handleFile(event.dataTransfer.files[0]);
  };

  const runOcr = async () => {
    if (!active?.image) {
      setError("Add a label photo before running OCR.");
      return;
    }
    setError("");
    setOcrProgress("Loading the on-device OCR engine…");
    setLoading(true);
    let worker: Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>> | undefined;
    try {
      const { createWorker } = await import("tesseract.js");
      worker = await createWorker("eng", 1, {
        workerPath: new URL(`${import.meta.env.BASE_URL}tesseract/worker.min.js`, window.location.href).href,
        corePath: new URL(`${import.meta.env.BASE_URL}tesseract/tesseract-core-lstm.wasm.js`, window.location.href).href,
        cacheMethod: "write",
        cachePath: "inspect-ai",
        workerBlobURL: false,
        logger: (message) => {
          if (message.status === "recognizing text") {
            setOcrProgress(`Reading text… ${Math.round(message.progress * 100)}%`);
          } else if (message.status) {
            setOcrProgress(`${message.status}…`);
          }
        },
      });
      const result = await worker.recognize(active.image);
      const rawOcrText = result.data.text.trim();
      const fields = parseOcrText(rawOcrText);
      const updated: ScanRecord = {
        ...active,
        fields,
        statuses: checkFields(fields),
        rawOcrText,
        source: "On-device OCR",
        analyzedAt: new Date().toISOString(),
      };
      setActive(updated);
      persistScan(updated);
      setScreen("results");
      setShowOcrText(true);
      if (!rawOcrText) setError("OCR did not find readable text. Try a sharper, well-lit photo.");
    } catch (cause) {
      setError(`On-device OCR could not finish: ${describeError(cause)}`);
    } finally {
      try {
        if (worker) await worker.terminate();
      } catch (cause) {
        setError(`Could not stop the OCR worker cleanly: ${describeError(cause)}`);
      } finally {
        setLoading(false);
        setOcrProgress("");
      }
    }
  };

  const rerunChecks = () => {
    if (!active) return;
    const updated = { ...active, statuses: checkFields(active.fields) };
    setActive(updated);
    persistScan(updated);
  };

  const deleteScan = async (scan: ScanRecord) => {
    if (!window.confirm(`Delete the scan for "${scan.imageName || "this image"}"?`)) return;
    setError("");
    try {
      await removeSavedScan(scan.id);
      setScans((current) => current.filter((item) => item.id !== scan.id));
      if (active?.id === scan.id) {
        setActive(null);
        setScreen("history");
      }
    } catch (cause) {
      setError(`Could not delete this scan: ${cause instanceof Error ? cause.message : "browser storage is unavailable."}`);
    }
  };

  const updateField = (key: FieldKey, value: string) => {
    if (!active) return;
    const fields = { ...active.fields, [key]: value };
    const updated = { ...active, fields, statuses: checkFields(fields) };
    setActive(updated);
    if (updated.analyzedAt) persistScan(updated);
  };

  const handleAuthentication = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError("");
    setAuthMessage("");
    if (!supabase) {
      setAuthError(supabaseConfigError || "Authentication is not configured.");
      return;
    }

    setAuthSubmitting(true);
    try {
      if (authMode === "signUp") {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: loginEmail.trim(),
          password: loginPassword,
        });
        if (signUpError) throw signUpError;
        if (data.session) {
          setOfflineMode(false);
          setAccountEmail(data.user?.email ?? loginEmail.trim());
          setLoginPassword("");
          setScreen("dashboard");
        } else {
          setAuthMessage("Account created. Check your email for the confirmation link, then sign in.");
          setAuthMode("signIn");
          setLoginPassword("");
        }
      } else {
        const { data, error: signInError } = await supabase.auth.signInWithPassword({
          email: loginEmail.trim(),
          password: loginPassword,
        });
        if (signInError) throw signInError;
        setOfflineMode(false);
        setAccountEmail(data.user.email ?? loginEmail.trim());
        setLoginPassword("");
        setScreen("dashboard");
      }
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : "Authentication failed. Please try again.");
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    setError("");
    if (offlineMode) {
      setOfflineMode(false);
      setAccountEmail("");
      setScreen("login");
      return;
    }
    if (!supabase) {
      setAuthError(supabaseConfigError || "Authentication is not configured.");
      return;
    }
    setAuthSubmitting(true);
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) {
      setAuthError(`Could not sign out: ${signOutError.message}`);
    } else {
      setAccountEmail("");
      setLoginEmail("");
      setLoginPassword("");
      setScreen("login");
    }
    setAuthSubmitting(false);
  };

  if (!authReady) {
    return <main className="auth-loading" aria-live="polite">Checking your sign-in…</main>;
  }

  const stopQrCamera = () => {
    qrControls.current?.stop();
    qrControls.current = null;
    setQrStatus("idle");
  };

  const startQrCamera = async () => {
    setQrError("");
    setQrText("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setQrError("Camera access is not available in this browser. You can scan a QR code from an image instead.");
      return;
    }
    setQrStatus("starting");
    try {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      const reader = new BrowserQRCodeReader();
      qrReader.current = reader;
      const controls = await reader.decodeFromVideoDevice(undefined, qrVideo.current ?? undefined, (result, _error, scanControls) => {
        if (result) {
          setQrText(result.getText());
          setQrError("");
          scanControls.stop();
          qrControls.current = null;
          setQrStatus("idle");
        }
      });
      if (qrReader.current !== reader || screen !== "qr") {
        controls.stop();
        return;
      }
      qrControls.current = controls;
      setQrStatus("scanning");
    } catch (cause) {
      qrReader.current = null;
      qrControls.current = null;
      setQrStatus("idle");
      setQrError(`Could not start the camera: ${cause instanceof Error ? cause.message : "check camera permissions and try again."}`);
    }
  };

  const handleQrImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setQrError("");
    setQrText("");
    if (!file.type.startsWith("image/")) {
      setQrError("Choose an image file containing a QR code.");
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    try {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      const reader = new BrowserQRCodeReader();
      const result = await reader.decodeFromImageUrl(objectUrl);
      setQrText(result.getText());
    } catch (cause) {
      setQrError(cause instanceof Error && cause.name === "NotFoundException"
        ? "No QR code was found in that image. Try a clearer, well-lit picture."
        : `Could not read the QR image: ${cause instanceof Error ? cause.message : "try another image."}`);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  };

  if (screen === "login") {
    return (
      <main className="login-page">
        <section className="login-story">
          <a className="brand login-brand" href="#" onClick={(event) => event.preventDefault()}>
            <span className="brand-mark">I</span>
            <span>Inspect AI</span>
          </a>
          <div className="login-story-copy">
            <p className="eyebrow">PACKAGED PRODUCT LABEL REVIEW</p>
            <h1>A thoughtful first look at the details on your labels.</h1>
            <p>Review visible package information with a student-built prototype. Upload a label photo to get started.</p>
            <div className="login-feature"><span><Icon name="check" /></span><p><strong>Made for preliminary review</strong><br />Extract details and review them at your own pace.</p></div>
            <div className="login-feature"><span><Icon name="photo" /></span><p><strong>Your scans stay in this browser</strong><br />Label images are stored locally on this device.</p></div>
          </div>
          <p className="login-story-footer">A student prototype — not an official service.</p>
        </section>
        <section className="login-panel" aria-labelledby="login-title">
          <form className="login-card" onSubmit={(event) => void handleAuthentication(event)}>
            <p className="login-datetime">
              <span className="login-live-indicator" aria-hidden="true" />
              <time dateTime={currentTime.toISOString()}>
                {currentTime.toLocaleString(undefined, { dateStyle: "full", timeStyle: "medium" })}
              </time>
            </p>
            <p className={`connection-indicator ${isOnline ? "connection-online" : "connection-offline"}`} role="status">
              <span className="connection-dot" aria-hidden="true" />
              {isOnline ? "Online — local scans stay on this device." : "Offline — you can still use your local workspace."}
            </p>
            <p className="eyebrow">WELCOME TO INSPECT AI</p>
            <h2 id="login-title">{authMode === "signIn" ? "Sign in to your workspace" : "Create your account"}</h2>
            <p className="login-description">{authMode === "signIn" ? "Sign in with your email and password to continue." : "Create an account to start reviewing product labels."}</p>
            {supabaseConfigError && <div className="error-banner auth-config-error" role="alert">{supabaseConfigError}</div>}
            {authError && <div className="error-banner auth-config-error" role="alert">{authError}</div>}
            {authMessage && <div className="auth-success-message" role="status">{authMessage}</div>}
            {offlineSupportError && <div className="error-banner auth-config-error" role="alert">{offlineSupportError}</div>}
            <label className="login-label" htmlFor="login-email">Email address</label>
            <input
              autoComplete="email"
              id="login-email"
              name="email"
              type="email"
              placeholder="you@example.com"
              required
              value={loginEmail}
              onChange={(event) => setLoginEmail(event.target.value)}
            />
            <div className="password-label-row">
              <label className="login-label" htmlFor="login-password">Password</label>
            </div>
            <input
              autoComplete={authMode === "signIn" ? "current-password" : "new-password"}
              id="login-password"
              name="password"
              type="password"
              placeholder={authMode === "signIn" ? "Enter your password" : "Create a password"}
              required
              value={loginPassword}
              onChange={(event) => setLoginPassword(event.target.value)}
            />
            <button className="button button-primary login-submit" type="submit" disabled={authSubmitting || Boolean(supabaseConfigError)}>
              {authSubmitting ? "Please wait…" : authMode === "signIn" ? "Sign in" : "Create account"}<Icon name="arrow" />
            </button>
            <div className="auth-mode-toggle">
              <span>{authMode === "signIn" ? "New to Inspect AI?" : "Already have an account?"}</span>
              <button type="button" onClick={() => { setAuthMode(authMode === "signIn" ? "signUp" : "signIn"); setAuthError(""); setAuthMessage(""); }}>
                {authMode === "signIn" ? "Create an account" : "Sign in"}
              </button>
            </div>
            <button className="button button-secondary offline-login-button" type="button" onClick={() => setOfflineMode(true)}>
              Continue in offline mode
            </button>
            <p className="offline-login-note">Offline mode uses scans saved in this browser. Sign-in and first-time OCR setup need internet.</p>
            <p className="login-trust">Label reviews are preliminary and must be checked by a person.</p>
          </form>
        </section>
      </main>
    );
  }

  const navigation = (
    <aside className="sidebar">
      <a className="brand sidebar-brand" href="#" onClick={(event) => { event.preventDefault(); setScreen("dashboard"); }} aria-label="Inspect AI dashboard">
        <span className="brand-mark">I</span>
        <span>Inspect AI</span>
      </a>
      <p className="nav-caption">WORKSPACE</p>
      <nav className="nav-links" aria-label="Main navigation">
        <button className={`nav-link ${screen === "dashboard" ? "selected" : ""}`} onClick={() => setScreen("dashboard")}>
          <Icon name="grid" />Dashboard
        </button>
        <button className={`nav-link ${screen === "history" ? "selected" : ""}`} onClick={() => setScreen("history")}>
          <Icon name="history" />Scan history
          {scans.length > 0 && <span className="nav-count">{scans.length}</span>}
        </button>
        <button className={`nav-link ${screen === "qr" ? "selected" : ""}`} onClick={() => { setQrError(""); setQrText(""); setScreen("qr"); }}>
          <Icon name="qr" />QR scanner
        </button>
      </nav>
      <div className="sidebar-note">
        <span className="account-avatar">{accountEmail.slice(0, 1).toUpperCase() || "D"}</span>
        <span className="account-copy"><strong>{accountEmail || "Demo user"}</strong><span>Student prototype</span></span>
        <button className="sign-out-button" onClick={() => void handleSignOut()} disabled={authSubmitting}>{offlineMode ? "Exit offline" : "Sign out"}</button>
      </div>
    </aside>
  );

  const header = (
    <header className="content-header">
      <div>
        <p className="breadcrumb">Inspect AI <span>/</span> {screen === "history" ? "Scan history" : screen === "scan" ? "New scan" : screen === "qr" ? "QR scanner" : screen === "results" ? "Label review" : "Dashboard"}</p>
        <p className="header-caption">Packaged product label review</p>
      </div>
      <button className="button button-primary header-action" onClick={beginScan}>
        <Icon name="scan" />Scan product
      </button>
    </header>
  );

  const renderRecentScan = (scan: ScanRecord) => (
    <article className="recent-item" key={scan.id}>
      <button className="recent-open" onClick={() => openScan(scan)}>
        <img className="scan-thumb" src={scan.image} alt="" />
        <span className="recent-copy">
          <strong>{scan.imageName || "Label image"}</strong>
          <span>{formatDate(scan.createdAt)}</span>
        </span>
      </button>
      <span className="source-tag">{scan.source}</span>
      <button className="icon-button delete-button" aria-label={`Delete ${scan.imageName || "scan"}`} onClick={() => void deleteScan(scan)}>
        <Icon name="trash" />
      </button>
    </article>
  );

  let content: ReactNode;
  if (screen === "dashboard") {
    content = (
      <>
        <section className="welcome-card">
          <div className="welcome-copy">
            <p className="eyebrow">YOUR LABEL REVIEW WORKSPACE</p>
            <h1>Make a first pass at the details on a product label.</h1>
            <p>Upload a clear photo to explore visible information. Results are preliminary and always need human review.</p>
            <button className="button button-primary" onClick={beginScan}><Icon name="scan" />Scan a product <Icon name="arrow" /></button>
          </div>
          <div className="welcome-art" aria-hidden="true">
            <div className="art-card art-card-back"><span /><span /><span /></div>
            <div className="art-card art-card-front"><Icon name="photo" /><span /><span /><i /></div>
            <div className="art-check"><Icon name="check" /></div>
          </div>
        </section>
        <section className="section-block">
          <div className="section-heading">
            <div><h2>Recent scans</h2><p>Your saved label reviews</p></div>
            {scans.length > 0 && <button className="text-button" onClick={() => setScreen("history")}>View all <Icon name="arrow" /></button>}
          </div>
          {scans.length ? (
            <div className="recent-list">{scans.slice(0, 4).map(renderRecentScan)}</div>
          ) : (
            <div className="empty-card">
              <span className="empty-icon"><Icon name="photo" /></span>
              <strong>No scans yet</strong>
              <p>Your saved scans will show up here.</p>
              <button className="button button-secondary" onClick={beginScan}>Start your first scan</button>
            </div>
          )}
        </section>
        <TrustNote />
      </>
    );
  } else if (screen === "history") {
    content = (
      <>
        <div className="page-title-row"><div><p className="eyebrow">YOUR WORKSPACE</p><h1>Scan history</h1><p>Saved in this browser on this device.</p></div></div>
        {scans.length ? <div className="recent-list history-list">{scans.map(renderRecentScan)}</div> : (
          <div className="empty-card history-empty"><span className="empty-icon"><Icon name="history" /></span><strong>No saved scans</strong><p>Analyze a label and it will appear here.</p><button className="button button-primary" onClick={beginScan}>Scan a product</button></div>
        )}
        <TrustNote />
      </>
    );
  } else if (screen === "scan") {
    content = (
      <>
        <div className="page-title-row"><button className="back-button" onClick={() => setScreen("dashboard")}><Icon name="back" />Dashboard</button><p className="eyebrow">NEW LABEL REVIEW</p><h1>Add a product photo</h1><p>Choose a clear, well-lit photo where the label text is easy to read.</p></div>
        <section className="upload-card">
          {active?.image ? (
            <>
              <div className="preview-toolbar"><div><strong>Photo ready</strong><span>{active.imageName}</span></div><div className="preview-actions"><button className="button button-secondary" onClick={() => fileInput.current?.click()}><Icon name="upload" />Replace</button><button className="icon-button" aria-label="Remove photo" onClick={() => updateActive({ image: "", imageName: "", analyzedAt: null, fields: { ...EMPTY_FIELDS }, statuses: { ...EMPTY_STATUSES }, rawOcrText: "", source: "Demo" })}><Icon name="close" /></button></div></div>
              <img className="image-preview" src={active.image} alt={`Preview of ${active.imageName}`} />
              <div className="upload-footer"><span>Image is resized and stays in this browser.</span><button className="button button-primary" onClick={() => void runOcr()} disabled={loading}>{loading ? ocrProgress || "Analyzing image…" : "Analyze label"}<Icon name="arrow" /></button></div>
            </>
          ) : (
            <div
              className={`drop-zone ${dragging ? "dragging" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <span className="upload-icon"><Icon name="upload" /></span>
              <h2>Drop your label photo here</h2>
              <p>or choose an image from your device</p>
              <button className="button button-primary" onClick={() => fileInput.current?.click()} disabled={loading}><Icon name="photo" />{loading ? "Preparing image…" : "Choose image"}</button>
              <span className="file-hint">JPG, PNG, or WebP · up to 12 MB</span>
            </div>
          )}
          <input ref={fileInput} className="visually-hidden" type="file" accept="image/*" onChange={onFileChange} aria-label="Choose a product label image" />
        </section>
        <section className="ocr-card">
          <span className="ocr-icon"><Icon name="sparkle" /></span>
          <div><strong>How image analysis works</strong><p>Analyze label reads visible English text from your image on this device and estimates label fields. The first run downloads OCR model files; extracted details may be incomplete or incorrect.</p></div>
        </section>
        <TrustNote />
      </>
    );
  } else if (screen === "qr") {
    content = (
      <>
        <div className="page-title-row">
          <button className="back-button" onClick={() => setScreen("dashboard")}><Icon name="back" />Dashboard</button>
          <p className="eyebrow">QR CODE READER</p>
          <h1>Scan a product QR code</h1>
          <p>Use your camera or choose a QR code image. The code’s contents are shown as text and aren’t opened automatically.</p>
        </div>
        <section className="qr-card">
          <div className="qr-camera-frame">
            {qrStatus === "idle" && !qrText && <div className="qr-camera-placeholder"><span className="qr-placeholder-icon"><Icon name="qr" /></span><strong>Camera preview</strong><span>Start the camera and point it at a QR code.</span></div>}
            <video ref={qrVideo} className={`qr-video ${qrStatus === "scanning" ? "visible" : ""}`} muted playsInline />
            {qrStatus === "scanning" && <div className="qr-target" aria-hidden="true"><span /><span /><span /><span /></div>}
            {qrStatus === "starting" && <div className="qr-camera-placeholder"><span className="qr-placeholder-icon"><Icon name="qr" /></span><strong>Starting camera…</strong><span>Your browser may ask for camera permission.</span></div>}
          </div>
          <div className="qr-controls">
            {qrStatus === "scanning"
              ? <button className="button button-secondary" onClick={stopQrCamera}><Icon name="close" />Stop camera</button>
              : <button className="button button-primary" onClick={() => void startQrCamera()} disabled={qrStatus === "starting"}><Icon name="qr" />{qrStatus === "starting" ? "Starting camera…" : "Start camera"}</button>}
            <span>Camera scanning requires permission and a secure connection (localhost is supported).</span>
          </div>
          <div className="qr-image-option">
            <div><strong>Prefer an image?</strong><p>Choose a photo or screenshot that contains a QR code.</p></div>
            <button className="button button-secondary" onClick={() => qrImageInput.current?.click()}><Icon name="photo" />Choose image</button>
            <input ref={qrImageInput} className="visually-hidden" type="file" accept="image/*" onChange={(event) => void handleQrImage(event)} aria-label="Choose an image containing a QR code" />
          </div>
        </section>
        {qrError && <div className="error-banner qr-error" role="alert"><span>{qrError}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setQrError("")}><Icon name="close" /></button></div>}
        {qrText && <section className="qr-result-card" aria-live="polite">
          <div className="qr-result-heading"><span className="qr-success-icon"><Icon name="check" /></span><div><h2>QR code found</h2><p>Review the contents before using them.</p></div><button className="text-button" onClick={() => { setQrText(""); setQrError(""); }}>Clear</button></div>
          <pre className="qr-result-text">{qrText}</pre>
          <p className="qr-safety-note">A QR code can contain incorrect or unsafe information. Its contents do not verify product details or legal compliance.</p>
        </section>}
        <TrustNote />
      </>
    );
  } else {
    const counts = active ? Object.values(active.statuses).reduce<Record<string, number>>((accumulator, status) => {
      accumulator[status] = (accumulator[status] ?? 0) + 1;
      return accumulator;
    }, {}) : {};
    content = active ? (
      <>
        <div className="results-topline"><button className="back-button" onClick={() => setScreen("history")}><Icon name="back" />Back to scans</button><span className={`source-tag ${active.source === "On-device OCR" ? "ocr-tag" : ""}`}>{active.source === "Demo" ? "Demo results" : "On-device OCR"}</span></div>
        <div className="page-title-row results-title"><p className="eyebrow">PRELIMINARY REVIEW</p><h1>Label details</h1><p>Review and correct the text below. These checks do not determine legal compliance.</p></div>
        <div className="results-layout">
          <section className="fields-card">
            <div className="card-heading"><div><h2>Extracted details</h2><p>All values can be edited. Changes save in this browser.</p></div><button className="button button-secondary" onClick={rerunChecks}><Icon name="check" />Re-run checks</button></div>
            <div className="field-list">
              {FIELD_DETAILS.map(({ key, label, hint }) => (
                <div className="field-row" key={key}>
                  <label htmlFor={`field-${key}`}>{label}<span>{hint}</span></label>
                  <input id={`field-${key}`} value={active.fields[key]} onChange={(event) => updateField(key, event.target.value)} placeholder="Not detected — enter if visible" />
                  <span className={`status-pill status-${active.statuses[key].toLowerCase().replace(/ /g, "-")}`}>{active.statuses[key]}</span>
                </div>
              ))}
            </div>
            {active.rawOcrText && <div className="ocr-transcript"><button className="text-button" onClick={() => setShowOcrText((current) => !current)}>{showOcrText ? "Hide" : "View"} OCR text</button>{showOcrText && <pre>{active.rawOcrText}</pre>}</div>}
            <p className="field-footnote">These preliminary checks look for visible text and simple formats only. They are not a rule-by-rule legal assessment.</p>
          </section>
          <aside className="summary-column">
            <section className="summary-card">
              <h2>Review summary</h2><p>Preliminary results only</p>
              <div className="summary-count"><strong>{(counts["Needs review"] ?? 0) + (counts["Needs rule verification"] ?? 0)}</strong><span>items to review</span></div>
              <ul className="summary-list">
                <li><span className="summary-dot dot-review" />Needs review <strong>{counts["Needs review"] ?? 0}</strong></li>
                <li><span className="summary-dot dot-missing" />Not detected <strong>{counts["Not detected"] ?? 0}</strong></li>
                <li><span className="summary-dot dot-verify" />Needs rule verification <strong>{counts["Needs rule verification"] ?? 0}</strong></li>
              </ul>
              <span className="status-pill status-found">{counts.Found ?? 0} found</span>
            </section>
            {active.image && <section className="side-preview"><img src={active.image} alt={`Label photo: ${active.imageName}`} /><span>{active.imageName}</span></section>}
            <div className="trust-card"><span className="notice-icon">i</span><p>A person must verify this information before relying on it. Inspect AI does not certify compliance.</p></div>
          </aside>
        </div>
        <p className="scan-time">Last checked {active.analyzedAt ? formatDate(active.analyzedAt) : "not analyzed yet"}</p>
      </>
    ) : (
      <div className="empty-card"><strong>No scan selected</strong><button className="button button-primary" onClick={beginScan}>Start a scan</button></div>
    );
  }

  return (
    <div className="app-shell">
      {navigation}
      <main className="main-panel">
        {header}
        <div className="content-area">
          <div className={`connection-banner ${isOnline ? "connection-online" : "connection-offline"}`} role="status">
            <span className="connection-dot" aria-hidden="true" />
            {isOnline
              ? "Online — scans and history are saved locally in this browser."
              : "You’re offline — scanning, QR image reading, saved history, and downloaded OCR remain available on this device."}
          </div>
          {offlineSupportError && <div className="error-banner" role="alert">{offlineSupportError}</div>}
          {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setError("")}><Icon name="close" /></button></div>}
          {content}
        </div>
      </main>
    </div>
  );
}

function TrustNote() {
  return (
    <div className="trust-note" role="note">
      <span className="notice-icon">i</span>
      <p><strong>For guidance, not certification.</strong> Results are preliminary and may be incorrect. A person must verify label details and applicable rules before relying on them.</p>
    </div>
  );
}

export default App;
