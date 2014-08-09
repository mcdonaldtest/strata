#!/usr/bin/env node

require('./proof')(3, function (step, Strata, tmp, serialize, gather, assert) {
    var strata = new Strata({ directory: tmp, leafSize: 3, branchSize: 3 })
    step(function () {
        serialize(__dirname + '/fixtures/ambiguous.before.json', tmp, step())
    }, function () {
        strata.open(step())
    }, function () {
        gather(strata, step())
    }, function (records) {
        assert(records, [ 'a', 'd', 'f', 'g', 'h', 'i', 'l', 'm', 'n' ], 'records')
    }, function () {
        strata.mutator('d', step())
    }, function (cursor) {
        step(function () {
            cursor.indexOf('e', step())
        }, function (index) {
            cursor.insert('e', 'e', ~index, step())
        }, function (unambiguous) {
            cursor.unlock(step())
            assert(unambiguous, 0, 'unambiguous')
        }, function () {
            gather(strata, step())
        })
    }, function (records) {
        assert(records, [ 'a', 'd', 'e', 'f', 'g', 'h', 'i', 'l', 'm', 'n' ], 'records after insert')
    }, function() {
        strata.close(step())
    })
})
