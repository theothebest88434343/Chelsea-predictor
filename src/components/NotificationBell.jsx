import { useState } from 'react';
import { Bell, BellOff } from 'lucide-react';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY ?? '';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return new Uint8Array([...rawData].map(c => c.charCodeAt(0)));
}

export default function NotificationBell() {
  const [status, setStatus] = useState(() => {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;
  });

  async function subscribe() {
    if (!('serviceWorker' in navigator) || !VAPID_PUBLIC_KEY) return;

    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      await fetch('/api/push/subscribe', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(sub),
      });
      setStatus('granted');
    } catch (err) {
      console.warn('[Push]', err.message);
    }
  }

  async function toggle() {
    if (status === 'granted') return;
    try {
      const perm = await Notification.requestPermission();
      setStatus(perm);
      if (perm === 'granted') await subscribe();
    } catch {}
  }

  if (status === 'unsupported') return null;

  return (
    <button
      onClick={toggle}
      style={{
        background: 'none', border: 'none', cursor: 'pointer',
        color: status === 'granted' ? 'var(--gold)' : 'var(--text-muted)',
        padding: 4, display: 'flex', alignItems: 'center',
      }}
      title={status === 'granted' ? 'Notifications on' : 'Enable notifications'}
    >
      {status === 'granted' ? <Bell size={20} /> : <BellOff size={20} />}
    </button>
  );
}
