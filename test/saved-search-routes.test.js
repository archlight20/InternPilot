const test = require('node:test');
const assert = require('node:assert/strict');

const candidateRouter = require('../routes/candidate');

function routeLayer(path, method) {
    return candidateRouter.stack.find(layer =>
        layer.route && layer.route.path === path && layer.route.methods[method]
    );
}

test('saved-search routes expose the full candidate-owned CRUD flow', () => {
    const expected = [
        ['get', '/candidate/saved-searches'],
        ['post', '/candidate/saved-searches'],
        ['patch', '/candidate/saved-searches/:id'],
        ['post', '/candidate/saved-searches/:id/pause'],
        ['delete', '/candidate/saved-searches/:id'],
        ['get', '/candidate/saved-searches/:id/edit'],
        ['get', '/candidate/saved-searches/:id/results']
    ];

    expected.forEach(([method, path]) => {
        const layer = routeLayer(path, method);
        assert.ok(layer, `${method.toUpperCase()} ${path} is registered`);
        // Every route starts with isAuthenticated and role authorization;
        // the handler itself additionally scopes data by candidate ID.
        assert.ok(layer.route.stack.length >= 3, `${path} includes auth middleware and a handler`);
        assert.equal(layer.route.stack[0].handle.name, 'isAuthenticated');
    });
});
