(() => {
    'use strict';

    const STORAGE_KEY = 'internpilot:theme';
    const modes = ['light', 'dark', 'system'];
    const labels = {
        light: 'Light mode',
        dark: 'Dark mode',
        system: 'System theme'
    };
    const icons = {
        light: 'ph-bold ph-sun text-lg',
        dark: 'ph-bold ph-moon text-lg',
        system: 'ph-bold ph-monitor text-lg'
    };
    const mediaQuery = window.matchMedia
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;

    function getStoredMode() {
        try {
            const stored = window.localStorage.getItem(STORAGE_KEY);
            return modes.includes(stored) ? stored : 'system';
        } catch (error) {
            return 'system';
        }
    }

    function isDark(mode) {
        return mode === 'dark' || (mode === 'system' && Boolean(mediaQuery && mediaQuery.matches));
    }

    function updateControls(mode) {
        const currentIndex = modes.indexOf(mode);
        const nextMode = modes[(currentIndex + 1) % modes.length];

        document.querySelectorAll('[data-theme-toggle]').forEach(button => {
            const icon = button.querySelector('[data-theme-icon]');
            const label = button.querySelector('[data-theme-label]');

            if (icon) icon.className = icons[mode];
            if (label) label.textContent = labels[mode];

            button.setAttribute('data-theme-mode', mode);
            button.setAttribute(
                'aria-label',
                `Theme: ${labels[mode]}. Activate to switch to ${labels[nextMode]}.`
            );
            button.title = `Theme: ${labels[mode]} (switch to ${labels[nextMode]})`;
        });
    }

    function applyTheme(mode) {
        const activeMode = modes.includes(mode) ? mode : 'system';
        document.documentElement.classList.toggle('dark', isDark(activeMode));
        document.documentElement.setAttribute('data-theme', activeMode);
        updateControls(activeMode);
    }

    function setTheme(mode) {
        try {
            window.localStorage.setItem(STORAGE_KEY, mode);
        } catch (error) {
            // Keep the selected preference for this page when storage is blocked.
        }
        applyTheme(mode);
    }

    function cycleTheme() {
        const currentMode = getStoredMode();
        const nextMode = modes[(modes.indexOf(currentMode) + 1) % modes.length];
        setTheme(nextMode);
    }

    function initializeThemeControls() {
        applyTheme(getStoredMode());
        document.querySelectorAll('[data-theme-toggle]').forEach(button => {
            button.addEventListener('click', cycleTheme);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeThemeControls, { once: true });
    } else {
        initializeThemeControls();
    }

    function syncSystemTheme() {
        if (getStoredMode() === 'system') applyTheme('system');
    }

    if (mediaQuery) {
        if (typeof mediaQuery.addEventListener === 'function') {
            mediaQuery.addEventListener('change', syncSystemTheme);
        } else if (typeof mediaQuery.addListener === 'function') {
            mediaQuery.addListener(syncSystemTheme);
        }
    }

    window.addEventListener('storage', event => {
        if (event.key === STORAGE_KEY) applyTheme(getStoredMode());
    });
})();
