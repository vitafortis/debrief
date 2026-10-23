// Applies the saved theme (or the system's) before paint, and wires up the toggle.
(() => {
	const KEY = 'debrief-site-theme';
	const root = document.documentElement;
	let saved = null;
	try { saved = localStorage.getItem(KEY); } catch {}
	const system = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
	root.dataset.theme = saved || system;

	document.addEventListener('click', (e) => {
		if (!e.target.closest('[data-theme-toggle]')) return;
		const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
		root.dataset.theme = next;
		try { localStorage.setItem(KEY, next); } catch {}
	});
})();
