/**
 * Options page — lists user-granted trusted origins with revoke buttons.
 * Pre-trusted origins (*.openobserve.ai, localhost) are never listed here.
 */

import { getTrustedOrigins, revokeTrust } from './trust';

async function render(): Promise<void> {
  const list = document.getElementById('trustedList');
  if (!list) return;

  const origins = await getTrustedOrigins();

  if (origins.length === 0) {
    list.innerHTML = '<li class="empty">No user-granted origins.</li>';
    return;
  }

  list.innerHTML = origins
    .map(
      origin => `
    <li class="trusted-item">
      <span>${escapeHtml(origin)}</span>
      <button data-origin="${escapeAttr(origin)}">Revoke</button>
    </li>`,
    )
    .join('');

  for (const btn of list.querySelectorAll<HTMLButtonElement>('button[data-origin]')) {
    btn.addEventListener('click', async () => {
      const origin = btn.getAttribute('data-origin')!;
      await revokeTrust(origin);
      await render();
    });
  }
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str: string): string {
  return str.replace(/"/g, '&quot;');
}

void render();
