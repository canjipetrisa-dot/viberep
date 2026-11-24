import { useState, useEffect, useRef } from 'react';
import confetti from 'canvas-confetti';
import jsQR from 'jsqr';
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import {
  initLimitr,
  addRep,
  getBalance,
  checkIn,
  checkTier,
  recordUsage,
  getReceipt,
} from './lib/limitr';
import './App.css';

// ---- constants ----

const HELLO_HTML = [
  '<!DOCTYPE html><html><head><style>',
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;',
  'background:#1a1a2e;color:#fff;font-family:system-ui;text-align:center;flex-direction:column}',
  'h1{font-size:3.5rem;margin:0}p{color:#888;margin-top:1rem;font-size:1.2rem}',
  '</style></head><body><h1>Hello judges</h1>',
  '<p>Your app will appear here</p></body></html>',
].join('');

const BUILD_COST = 5;
const BUILD_MODEL = 'claude-sonnet-5-5';
const BUILD_IN_PRICE = 2;   // $/MTok
const BUILD_OUT_PRICE = 10;  // $/MTok

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
const MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// ---- pure helpers ----

interface Pt { x: number; y: number; visibility: number }

function speak(text: string) {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.1;
  speechSynthesis.speak(u);
}

function coachForBalance(b: number): string {
  if (b >= BUILD_COST) return 'Build unlocked \u2014 type what you want';
  return `Squat! ${Math.max(0, BUILD_COST - b)} more to build`;
}

function calcAngle(a: Pt, b: Pt, c: Pt): number {
  const bax = a.x - b.x, bay = a.y - b.y;
  const bcx = c.x - b.x, bcy = c.y - b.y;
  const dot = bax * bcx + bay * bcy;
  const cross = Math.abs(bax * bcy - bay * bcx);
  return Math.atan2(cross, dot) * (180 / Math.PI);
}

function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: Pt[],
  w: number,
  h: number,
) {
  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth = 3;
  for (const conn of PoseLandmarker.POSE_CONNECTIONS) {
    const a = landmarks[conn.start];
    const b = landmarks[conn.end];
    if (a.visibility < 0.3 || b.visibility < 0.3) continue;
    ctx.beginPath();
    ctx.moveTo(a.x * w, a.y * h);
    ctx.lineTo(b.x * w, b.y * h);
    ctx.stroke();
  }
  ctx.fillStyle = '#ff6b35';
  for (const lm of landmarks) {
    if (lm.visibility < 0.3) continue;
    ctx.beginPath();
    ctx.arc(lm.x * w, lm.y * h, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---- component ----

export default function App() {
  // ---- state ----
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState(1);
  const [balance, setBalance] = useState(0);
  const [coachLine, setCoachLine] = useState('');
  const [coachRed, setCoachRed] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [currentHtml, setCurrentHtml] = useState(HELLO_HTML);
  const [isBuilding, setIsBuilding] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [checkedIn, setCheckedIn] = useState(false);
  const [cameraMode, setCameraMode] = useState<'scan' | 'squat'>('scan');
  const [kneeAngle, setKneeAngle] = useState<number | null>(null);
  const [repFlash, setRepFlash] = useState(false);
  const [streamingCode, setStreamingCode] = useState('');
  const [rightTab, setRightTab] = useState<'preview' | 'code'>('preview');

  // ---- refs ----
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const receiptTimer = useRef(0);
  const stepRef = useRef(step);
  const checkedInRef = useRef(checkedIn);
  const cameraModeRef = useRef(cameraMode);
  stepRef.current = step;
  checkedInRef.current = checkedIn;
  cameraModeRef.current = cameraMode;

  const codeViewRef = useRef<HTMLPreElement>(null);
  const cameraAreaRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);
  const squatPhaseRef = useRef<'up' | 'down'>('up');
  const rafRef = useRef(0);
  const videoReadyRef = useRef(false);
  const lastAngleTs = useRef(0);
  const isBuildingRef = useRef(false);

  // ---- component helpers ----
  function setCoach(text: string, red = false) {
    setCoachLine(text);
    setCoachRed(red);
    speak(text);
  }

  async function refreshBal(): Promise<number> {
    const b = await getBalance();
    setBalance(b);
    return b;
  }

  // ---- camera processing functions (use refs only) ----

  function startScanLoop() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const scan = () => {
      if (cameraModeRef.current !== 'scan') return;
      if (video.readyState < 2) {
        rafRef.current = requestAnimationFrame(scan);
        return;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height);
      if (code) {
        handleCheckIn();
      } else {
        rafRef.current = requestAnimationFrame(scan);
      }
    };
    rafRef.current = requestAnimationFrame(scan);
  }

  async function initPoseLandmarker() {
    try {
      const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
      try {
        poseLandmarkerRef.current = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
        });
      } catch {
        poseLandmarkerRef.current = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
        });
      }
    } catch (err) {
      console.error('PoseLandmarker init failed:', err);
    }
  }

  function startSquatLoop() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const detect = () => {
      if (!poseLandmarkerRef.current || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(detect);
        return;
      }
      const result = poseLandmarkerRef.current.detectForVideo(video, performance.now());
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (result.landmarks.length > 0) {
        const lm = result.landmarks[0] as Pt[];
        drawSkeleton(ctx, lm, canvas.width, canvas.height);
        processSquat(lm);
      }
      rafRef.current = requestAnimationFrame(detect);
    };
    rafRef.current = requestAnimationFrame(detect);
  }

  function processSquat(landmarks: Pt[]) {
    const left = [landmarks[23], landmarks[25], landmarks[27]];
    const right = [landmarks[24], landmarks[26], landmarks[28]];
    const leftVis = left.reduce((s, l) => s + l.visibility, 0) / 3;
    const rightVis = right.reduce((s, l) => s + l.visibility, 0) / 3;
    const [hip, knee, ankle] = leftVis >= rightVis ? left : right;

    if (Math.min(hip.visibility, knee.visibility, ankle.visibility) < 0.3) {
      return;
    }
    const angle = calcAngle(hip, knee, ankle);

    // throttle React state to ~10 fps
    const now = performance.now();
    if (now - lastAngleTs.current > 100) {
      setKneeAngle(angle);
      lastAngleTs.current = now;
    }

    if (angle < 150 && squatPhaseRef.current === 'up') {
      squatPhaseRef.current = 'down';
    } else if (angle > 160 && squatPhaseRef.current === 'down') {
      squatPhaseRef.current = 'up';
      addRepAction.current();
      setRepFlash(true);
      setTimeout(() => setRepFlash(false), 500);
    }
  }

  // ---- check-in (shared by QR scan and button) ----

  async function handleCheckIn() {
    const ok = await checkIn();
    setCheckedIn(true);
    setStep(2);
    if (ok) {
      setCoach('Checked in. Do a set, then build.');
    } else {
      setCoach('Already checked in today. Nice try.');
    }
    const b = await refreshBal();
    switchToSquatMode();
    setTimeout(() => {
      const msg = coachForBalance(b);
      setCoachLine(msg);
      setCoachRed(false);
      speak(msg);
    }, 2500);
  }

  function switchToSquatMode() {
    setCameraMode('squat');
    cancelAnimationFrame(rafRef.current);
    if (videoReadyRef.current) {
      startSquatLoop();
    }
  }

  // ---- Init Limitr ----
  useEffect(() => {
    let alive = true;
    initLimitr().then(async () => {
      if (!alive) return;
      await refreshBal();
      setReady(true);
      setCoachLine('Scan your gym pass to start');
      speak('Scan your gym pass to start');
    });
    return () => { alive = false; };
  }, []);

  // ---- Camera init ----
  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then((stream) => {
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        video.play().catch((e: unknown) => console.error('play():', e));

        video.addEventListener(
          'loadeddata',
          () => {
            const canvas = canvasRef.current;
            if (canvas) {
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
            }
            videoReadyRef.current = true;
            if (checkedInRef.current) {
              startSquatLoop();
            } else {
              startScanLoop();
            }
            initPoseLandmarker();
          },
          { once: true },
        );
      })
      .catch((err: DOMException) => {
        setCoachLine(`Camera: ${err.name} \u2014 ${err.message}`);
        setCoachRed(true);
      });

    return () => {
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // ---- confetti helpers ----
  function fireRepConfetti() {
    const el = cameraAreaRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = (rect.left + rect.width / 2) / window.innerWidth;
    const y = rect.top / window.innerHeight;
    confetti({
      particleCount: 120,
      spread: 80,
      startVelocity: 45,
      origin: { x, y },
      colors: ['#ff6b35', '#ff8c42', '#ffb347', '#00ff88', '#00cc6a'],
      gravity: 0.9,
      scalar: 1.2,
      ticks: 100,
    });
  }

  function fireUnlockConfetti() {
    // two bursts from each side for a dramatic effect
    const defaults = {
      particleCount: 100,
      spread: 70,
      startVelocity: 55,
      colors: ['#ff6b35', '#ff8c42', '#ffb347', '#00ff88', '#00cc6a', '#ffffff'],
      gravity: 0.7,
      scalar: 1.4,
      ticks: 150,
    };
    confetti({ ...defaults, angle: 60, origin: { x: 0, y: 0.5 } });
    confetti({ ...defaults, angle: 120, origin: { x: 1, y: 0.5 } });
    setTimeout(() => {
      confetti({ ...defaults, particleCount: 80, angle: 90, origin: { x: 0.5, y: 0 } });
    }, 150);
  }

  // ---- Spacebar → +1 rep ----
  const addRepAction = useRef<() => Promise<void>>(async () => {});

  addRepAction.current = async () => {
    await addRep();
    const b = await refreshBal();
    setFlash(true);
    setTimeout(() => setFlash(false), 400);
    if (stepRef.current < 2) setStep(2);
    fireRepConfetti();
    if (b >= BUILD_COST && b - 1 < BUILD_COST) {
      fireUnlockConfetti();
    }
    const msg = coachForBalance(b);
    setCoachLine(msg);
    setCoachRed(false);
    speak(msg);
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code === 'Space' && document.activeElement !== textareaRef.current) {
        e.preventDefault();
        addRepAction.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ---- Build ----
  async function handleBuild() {
    if (isBuildingRef.current) return;
    isBuildingRef.current = true;

    try {
      if (!import.meta.env.VITE_ANTHROPIC_API_KEY) {
        setCoach('Add your Anthropic API key to .env.local', true);
        return;
      }

      if (!checkedInRef.current) {
        setCoach('Check in first!');
        return;
      }

      const result = await checkTier('prompt_quick', BUILD_COST);
      if (!result.allowed) {
        const deficit = BUILD_COST - (result.remaining ?? 0);
        setCoach(
          `Drop and give me ${deficit} squats, then we'll build.`,
          true,
        );
        return;
      }

      if (!prompt.trim()) {
        setCoach('Type what you want to build first!');
        return;
      }

      setStep(3);
      setIsBuilding(true);
      setStreamingCode('');
      setRightTab('code');
      setCoachLine('Building\u2026');
      setCoachRed(false);

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': import.meta.env.VITE_ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: BUILD_MODEL,
          max_tokens: 4096,
          stream: true,
          system:
            'You are a web developer. Return ONLY a complete single-file HTML page ' +
            '(with inline CSS and JS) that applies the user\u2019s request to the current page. ' +
            'No markdown fences, no explanation \u2014 just the raw HTML document.',
          messages: [
            {
              role: 'user',
              content: `Current page:\n\n${currentHtml}\n\nRequest: ${prompt.trim()}`,
            },
          ],
        }),
      });

      if (!resp.ok) {
        throw new Error(`API returned ${resp.status}`);
      }

      let fullText = '';
      let inTok = 0;
      let outTok = 0;

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const lines = buf.split('\n');
        buf = lines.pop()!;

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const json = line.slice(6);
          if (json === '[DONE]') continue;
          try {
            const evt = JSON.parse(json);
            if (evt.type === 'content_block_delta' && evt.delta?.text) {
              fullText += evt.delta.text;
              setStreamingCode(fullText);
              if (codeViewRef.current) {
                codeViewRef.current.scrollTop = codeViewRef.current.scrollHeight;
              }
            }
            if (evt.type === 'message_delta' && evt.usage) {
              outTok = evt.usage.output_tokens ?? outTok;
            }
            if (evt.type === 'message_start' && evt.message?.usage) {
              inTok = evt.message.usage.input_tokens ?? 0;
            }
          } catch { /* skip non-JSON lines */ }
        }
      }

      const html = fullText.replace(/^```html?\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      const usdCost = (inTok * BUILD_IN_PRICE + outTok * BUILD_OUT_PRICE) / 1_000_000;

      setCurrentHtml(html);
      setRightTab('preview');
      await recordUsage('prompt_quick', BUILD_COST, usdCost);
      const b = await refreshBal();

      const snap = await getReceipt();
      const marginRaw = snap.margin ?? snap.margin_percent ?? snap.percent;
      const marginStr =
        marginRaw != null ? `${Number(marginRaw).toFixed(1)}%` : 'N/A';

      clearTimeout(receiptTimer.current);
      setReceipt(
        `Paid: ${BUILD_COST} squats \u00b7 Claude cost: $${usdCost.toFixed(4)} \u00b7 Gym margin: ${marginStr}`,
      );
      receiptTimer.current = window.setTimeout(() => setReceipt(null), 5000);

      setPrompt('');
      const msg = coachForBalance(b);
      setCoachLine(msg);
      setCoachRed(false);
      speak(msg);
    } catch (err) {
      console.error(err);
      setCoach('API error \u2014 check your key and try again', true);
    } finally {
      setIsBuilding(false);
      isBuildingRef.current = false;
    }
  }

  // ---- Render ----
  if (!ready) {
    return (
      <div className="loading">
        <div className="loading-spinner" />
        <div className="loading-text">Warming up&hellip;</div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">VIBEREP</h1>
        <p className="app-tagline">Rate limits, but make them leg day.</p>
      </header>

      <nav className="steps">
        <div className={`step ${step === 1 ? 'current' : ''} ${step > 1 ? 'done' : ''}`}>
          <span className="step-num">1</span> Check in
        </div>
        <span className="step-arrow">&rarr;</span>
        <div className={`step ${step === 2 ? 'current' : ''} ${step > 2 ? 'done' : ''}`}>
          <span className="step-num">2</span> Earn reps
        </div>
        <span className="step-arrow">&rarr;</span>
        <div className={`step ${step === 3 ? 'current' : ''}`}>
          <span className="step-num">3</span> Build
        </div>
      </nav>

      <div className="main">
        {/* ---- Left panel ---- */}
        <div className="left">
          {/* Camera */}
          <div ref={cameraAreaRef} className="camera-area">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="camera-video"
            />
            <canvas ref={canvasRef} className="camera-canvas" />

            {cameraMode === 'scan' && (
              <div className="camera-scan-label">Scan your gym pass</div>
            )}

            {kneeAngle !== null && cameraMode === 'squat' && (
              <div className="angle-badge">{Math.round(kneeAngle)}&deg;</div>
            )}

            {repFlash && <div className="rep-flash-overlay">+1</div>}

            {!checkedIn && (
              <div className="camera-checkin-overlay">
                <button className="btn-checkin" onClick={handleCheckIn}>
                  Simulate check-in
                </button>
              </div>
            )}
          </div>

          {/* Balance */}
          <div className={`balance-display ${flash ? 'flash' : ''}`}>
            <span className="balance-num">{Math.max(0, balance)}</span>
            <span className="balance-label">REPS</span>
          </div>

          {/* Coach */}
          <div className={`coach ${coachRed ? 'coach-danger' : ''}`}>
            {coachLine}
          </div>

          {/* Prompt */}
          <textarea
            ref={textareaRef}
            className="prompt-input"
            placeholder="What do you want to build?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
          />

          {/* Build button */}
          {(() => {
            const affordable = balance >= BUILD_COST;
            const fill = Math.max(0, Math.min(100, (balance / BUILD_COST) * 100));
            return (
              <button
                className={`build-btn ${affordable ? 'build-unlocked' : 'build-locked'}`}
                onClick={handleBuild}
                disabled={isBuilding}
              >
                <div className="build-fill" style={{ width: `${fill}%` }} />
                <span className="build-label">BUILD &middot; {BUILD_COST} squats</span>
              </button>
            );
          })()}
        </div>

        {/* ---- Right panel ---- */}
        <div className="right">
          <div className="right-tabs">
            <button
              className={`right-tab ${rightTab === 'preview' ? 'right-tab-active' : ''}`}
              onClick={() => setRightTab('preview')}
            >
              Preview
            </button>
            <button
              className={`right-tab ${rightTab === 'code' ? 'right-tab-active' : ''}`}
              onClick={() => setRightTab('code')}
            >
              Code
            </button>
          </div>

          {rightTab === 'code' ? (
            <pre ref={codeViewRef} className="code-view">{streamingCode || '\u200b'}</pre>
          ) : (
            <iframe
              className="preview-frame"
              srcDoc={currentHtml}
              title="Preview"
              sandbox="allow-scripts"
            />
          )}
        </div>
      </div>

      {/* ---- +1 REP corner button ---- */}
      <button
        className={`add-rep-btn ${flash ? 'flash' : ''}`}
        onClick={() => addRepAction.current()}
      >
        +1 REP
      </button>

      {/* ---- Receipt bar ---- */}
      {receipt && <div className="receipt-bar">{receipt}</div>}
    </div>
  );
}
