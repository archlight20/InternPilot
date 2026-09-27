const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ejs = require('ejs');

const root = path.join(__dirname, '..');
const layout = fs.readFileSync(path.join(root, 'views', 'layouts', 'boilerplate.ejs'), 'utf8');
const motionHead = fs.readFileSync(path.join(root, 'views', 'partials', 'motion-head.ejs'), 'utf8');
const headerPath = path.join(root, 'views', 'partials', 'header.ejs');
const header = fs.readFileSync(headerPath, 'utf8');
const themeScript = fs.readFileSync(path.join(root, 'public', 'js', 'theme.js'), 'utf8');
const themeStyles = fs.readFileSync(path.join(root, 'public', 'css', 'theme.css'), 'utf8');

function createThemeEnvironment({ storedTheme = null, systemDark = false } = {}) {
    const storage = new Map(storedTheme ? [['internpilot:theme', storedTheme]] : []);
    const htmlClasses = new Set();
    const attributes = new Map();
    const listeners = {};
    const mediaListeners = {};

    const createControl = () => {
        const icon = { className: '' };
        const label = { textContent: '' };
        const controlListeners = {};
        return {
            attributes: new Map(),
            icon,
            label,
            title: '',
            addEventListener(type, listener) {
                controlListeners[type] = listener;
            },
            click() {
                controlListeners.click();
            },
            querySelector(selector) {
                if (selector === '[data-theme-icon]') return icon;
                if (selector === '[data-theme-label]') return label;
                return null;
            },
            setAttribute(name, value) {
                this.attributes.set(name, value);
            }
        };
    };

    const controls = [createControl(), createControl()];
    const mediaQuery = {
        matches: systemDark,
        addEventListener(type, listener) {
            mediaListeners[type] = listener;
        }
    };
    const window = {
        localStorage: {
            getItem(key) { return storage.has(key) ? storage.get(key) : null; },
            setItem(key, value) { storage.set(key, value); }
        },
        matchMedia() { return mediaQuery; },
        addEventListener(type, listener) { listeners[type] = listener; }
    };
    const document = {
        readyState: 'complete',
        documentElement: {
            classList: {
                toggle(name, enabled) {
                    if (enabled) htmlClasses.add(name);
                    else htmlClasses.delete(name);
                },
                contains(name) { return htmlClasses.has(name); }
            },
            setAttribute(name, value) { attributes.set(name, value); }
        },
        querySelectorAll(selector) {
            assert.equal(selector, '[data-theme-toggle]');
            return controls;
        }
    };

    return { window, document, controls, mediaQuery, mediaListeners, storage };
}

test('theme bootstrap configures class-based Tailwind before its CDN script and avoids a flash', () => {
    assert.match(motionHead, /window\.tailwind\.config[\s\S]*darkMode:\s*'class'/);
    assert.match(motionHead, /document\.documentElement\.classList\.toggle\('dark', isDark\)/);
    assert.ok(
        layout.indexOf("include('../partials/motion-head')") < layout.indexOf('https://cdn.tailwindcss.com'),
        'theme bootstrap must be included before Tailwind loads'
    );
    assert.match(layout, /<script src="\/js\/theme\.js" defer><\/script>/);
    assert.match(layout, /<link rel="stylesheet" href="\/css\/theme\.css">/);
});

test('header keeps every control readable in dark mode and provides desktop and mobile theme controls', () => {
    const html = ejs.render(header, {
        currentPath: '/candidate/applications',
        currentUser: { _id: 'candidate-id', name: 'Candidate User', role: 'candidate', savedInternships: [] },
        navigation: { applications: true },
        notificationUnreadCount: 0
    }, { filename: headerPath });

    assert.equal((html.match(/data-theme-toggle/g) || []).length, 2);
    assert.match(html, /dark:bg-slate-950/);
    assert.match(html, /dark:text-slate-300/);
    assert.match(html, /dark:text-slate-200/);
    assert.match(html, /dark:bg-indigo-950/);
    assert.match(html, /dark:hover:bg-slate-800/);
    assert.match(html, /dark:border-slate-700/);
    assert.match(html, /dark:focus-visible:ring-offset-slate-950/);
});

test('theme controller cycles light, dark, and system modes while keeping controls in sync', () => {
    const environment = createThemeEnvironment({ systemDark: true });
    vm.runInNewContext(themeScript, environment);

    assert.equal(environment.document.documentElement.classList.contains('dark'), true);
    assert.equal(environment.controls[0].label.textContent, 'System theme');
    assert.equal(environment.controls[0].icon.className, 'ph-bold ph-monitor text-lg');

    environment.controls[0].click();
    assert.equal(environment.storage.get('internpilot:theme'), 'light');
    assert.equal(environment.document.documentElement.classList.contains('dark'), false);
    assert.equal(environment.controls[1].label.textContent, 'Light mode');

    environment.controls[1].click();
    assert.equal(environment.storage.get('internpilot:theme'), 'dark');
    assert.equal(environment.document.documentElement.classList.contains('dark'), true);
    assert.match(environment.controls[0].attributes.get('aria-label'), /switch to System theme/);

    environment.controls[0].click();
    assert.equal(environment.storage.get('internpilot:theme'), 'system');
    assert.equal(environment.controls[0].label.textContent, 'System theme');
    assert.equal(typeof environment.mediaListeners.change, 'function');
});

test('shared theme stylesheet changes only dark-mode neutral fallbacks and preserves form readability', () => {
    assert.match(themeStyles, /html\.dark \.bg-white:not\(\[class\*="dark:bg-"\]\)/);
    assert.match(themeStyles, /html\.dark \.text-slate-900:not\(\[class\*="dark:text-"\]\)/);
    assert.match(themeStyles, /html\.dark \.border-slate-200:not\(\[class\*="dark:border-"\]\)/);
    assert.match(themeStyles, /html\.dark input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)/);
    assert.doesNotMatch(themeStyles, /^body\s*\{/m);
});
