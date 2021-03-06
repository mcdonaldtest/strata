require('proof')(3, prove)

function prove (okay) {
    var recorder = require('../../recorder')(function (buffer, start, end) { return String(end) })
    var buffer = recorder({ length: 0 }, Buffer.from('"a"'))
    okay(buffer.toString().split(/\n/).slice(0, -1).map(function (line) {
        return JSON.parse(line)
    }), [ [ '12', '3' ], { length: 4 }, 'a' ], 'buffer')
    var buffer = recorder({ length: 0 }, 'a')
    okay(buffer.toString().split(/\n/).slice(0, -1).map(function (line) {
        return JSON.parse(line)
    }), [ [ '24', '3' ], { length: 4, json: true }, 'a' ], 'string')
    var buffer = recorder({ length: 0 })
    okay(buffer.toString().split(/\n/).slice(0, -1).map(function (line) {
        return JSON.parse(line)
    }), [ [ '12' ], { length: 0 } ], 'no body')
}
