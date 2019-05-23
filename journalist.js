const ascension = require('ascension')
const fileSystem = require('fs')
const fs = require('fs').promises
const path = require('path')
const recorder = require('./recorder')
const Splitter = require('./splitter')
const find = require('./find')
const assert = require('assert')
const Cursor = require('./cursor')
const Queue = require('p-queue')
const callback = require('prospective/callback')
const coalesece = require('extant')
const Future = require('prospective/future')
const Commit = require('./commit')

const appendable = require('./appendable')

const Strata = { Error: require('./error') }

function increment (value) {
    if (value == 0xffffffff) {
        return 0
    } else {
        return value + 1
    }
}

class Journalist {
    constructor (options) {
        const leaf = coalesece(options.leaf, {})
        this.leaf = {
            split: coalesece(leaf.split, 5),
            merge: coalesece(leaf.merge, 2)
        }
        const branch = coalesece(options.branch, {})
        this.branch = {
            split: coalesece(branch.split, 5),
            merge: coalesece(branch.merge, 2)
        }
        this.cache = options.cache
        this.instance = 0
        this.directory = options.directory
        this.comparator = options.comparator || ascension([ String ], (value) => value)
        this._recorder = recorder(() => '0')
        this._root = null
        this._operationId = 0xffffffff
        this._appenders = [ new Queue ]
        this._queues = {}
        this._blockId = 0xffffffff
        this._blocks = [{}]
        this._housekeeping = new Queue
        this._dirty = {}
        this._id = 0
    }

    async create () {
        const directory = this.directory
        this._root = this.cache.hold([ directory, -1 ], { items: [{ id: '0.0' }] })
        const stat = await fs.stat(directory)
        Strata.Error.assert(stat.isDirectory(), 'create.not.directory', { directory: directory })
        Strata.Error.assert((await fs.readdir(directory)).filter(file => {
            return ! /^\./.test(file)
        }).length == 0, 'create.directory.not.empty', { directory: directory })
        await fs.mkdir(path.resolve(directory, 'instance', '0'), { recursive: true })
        const pages = path.resolve(directory, 'pages')
        await fs.mkdir(path.resolve(pages, '0.0'), { recursive: true })
        await fs.writeFile(path.resolve(pages, '0.0', '0.0'), this._recorder.call(null, {
            method: 'insert',
            index: 0,
            value: { id: '0.1', key: null }
        }))
        await fs.mkdir(path.resolve(pages, '0.1'), { recursive: true })
        await fs.writeFile(path.resolve(pages, '0.1', '0.0'), Buffer.alloc(0))
    }

    async open () {
        const directory = this.directory
        this._root = this.cache.hold([ directory, -1 ], { items: [{ id: '0.0' }] })
        const instances = (await fs.readdir(path.join(directory, 'instances')))
            .filter(file => /^\d+$/.test(file))
            .map(file => +file)
            .sort((left, right) => right - left)
        this.instance = instances[0] + 1
        await fs.mkdir(path.join(directory, 'instances', String(this.instance)))
        for (let instance of instances) {
            await fs.rmdir(path.resolve(directory, 'instances', String(instance)))
        }
    }

    async appendable (id, leaf) {
        const regex = leaf ? /^\d+\.\d+$/ : /^\d+\.\d+\.[a-z0-9]+$/
        const dir = await fs.readdir(path.join(this.directory, 'pages', id))
        return dir.filter(function (file) {
            return regex.test(file)
        }).sort(appendable).pop()
    }

    async read (id) {
        const directory = path.resolve(this.directory, 'pages', String(id))
        const items = [], leaf = +id.split('.')[1] % 2 == 1
        let heft = 0
        const splitter = new Splitter(function () { return '0' })
        const append = await this.appendable(id, true)
        const filename = path.join(directory, append)
        const readable = fileSystem.createReadStream(filename)
        for await (let chunk of readable) {
            splitter.split(chunk).forEach(function (entry) {
                switch (entry.header.method) {
                case 'insert':
                    if (leaf) {
                        items.splice(entry.header.index, 0, {
                            key: entry.header.key,
                            value: entry.body,
                            heft: entry.sizes[0] + entry.sizes[1]
                        })
                        heft += entry.sizes[0] + entry.sizes[1]
                    } else {
                        items.splice(entry.header.index, 0, {
                            id: entry.header.value.id,
                            key: entry.header.value.key,
                            heft: entry.sizes[0]
                        })
                        heft += entry.sizes[0]
                    }
                }
            })
        }
        // TODO Did we ghost? Check when we implement remove.
        return { id, leaf, items, ghosts: 0, heft, append }
    }

    async load (id) {
        const entry = this._hold(id, null)
        try {
            if (entry.value == null) {
                entry.value = await this.read(id)
                entry.heft = entry.value.heft
            }
        } finally {
            entry.release()
        }
    }

    _hold (id, initial) {
        return this.cache.hold([ this.directory, id ], initial)
    }

    // TODO If `key` is `null` then just go left.
    _descend (key, level, fork) {
        const descent = {
            entries: [],
            miss: null,
            entry: null,
            page: null,
            keyed: null,
            level: 0,
            index: 0
        }
        let entry = null
        descent.entries.push(entry = this._hold(-1, null))
        for (;;) {
            if (descent.index != 0) {
                descent.keyed = {
                    key: page.items[descent.index].key,
                    level: descent.level
                }
            }
            var id = entry.value.items[descent.index].id
            descent.entries.push(entry = this._hold(id, null))
            if (entry.value == null) {
                descent.entries.pop().remove()
                descent.miss = id
                return descent
            }
            var page = entry.value
            // TODO Maybe page offset instead of ghosts, nah leave it so you remember it.
            descent.index = find(this.comparator, page, key, page.leaf ? page.ghosts : 1)
            if (page.leaf) {
                assert.equal(level, -1, 'could not find branch')
                break
            } else if (descent.index < 0) {
                // On a branch, unless we hit the key exactly, we're
                // pointing at the insertion point which is right after the
                // branching we're supposed to decend, so back it up one
                // unless it's a bullseye.
                descent.index = ~descent.index - 1
                if (level == descent.level) {
                    break
                }
            } else if (fork != 0) {
                if (fork < 0) {
                    if (descent.index-- == 0) {
                        return null
                    }
                } else {
                    if (++descent.index == page.items.length) {
                        return null
                    }
                }
            }
            descent.level++
        }
        descent.entry = descent.entries[descent.entries.length - 1]
        descent.page = descent.entry.value
        return descent
    }

    async descend (key, level, fork) {
        let entries = []
        for (;;) {
            var descent = this._descend(key, level, fork)
            entries.forEach((entry) => entry.release())
            if (descent.miss == null) {
                return descent
            }
            entries = descent.entries
            await this.load(descent.miss)
        }
    }

    async close () {
        if (this._root != null) {
            this._root.remove()
            this._root = null
        }
    }

    async _writeLeaf (id, writes) {
        const append = await this.appendable(id, true)
        const recorder = this._recorder
        const entry = this._hold(id, null)
        const buffers = writes.map(write => {
            const buffer = recorder(write.header, write.body)
            if (write.header.method == 'insert') {
                entry.heft += (write.record.heft = buffer.length)
            }
            return buffer
        })
        entry.release()
        const file = path.resolve(this.directory, 'pages', id, append)
        await fs.appendFile(file, Buffer.concat(buffers))
    }

    _queue (id) {
        let queue = this._queues[id]
        if (queue == null) {
            const appender = this._appenders[this._index(id)]
            queue = this._queues[id] = {
                id: this._operationId = increment(this._operationId),
                writes: [],
                entry: this._hold(id, null),
                promise: appender.add(() => this._append('write', id))
            }
        }
        return queue
    }

    _block (blockId, id) {
        const index = this._index(id)
        let block = this._blocks[index][blockId]
        if (block == null) {
            this._blocks[index][blockId] = block = { enter: new Future, exit: new Future }
            this._appenders[index].add(() => this._append('block', [ index, blockId ]))
        }
        return block
    }

    async _append (method, body) {
        await callback((callback) => process.nextTick(callback))
        switch (method) {
        case 'write':
            const id = body
            const queue = this._queues[id]
            delete this._queues[id]
            const entry = queue.entry, page = entry.value
            if (
                page.items.length >= this.leaf.split ||
                (
                    (page.id != '0.1' || page.right != null) &&
                    page.items.length <= this.leaf.merge
                )
            ) {
                this._tidy(page.items[0].key)
            }
            await this._writeLeaf(id, queue.writes)
            break
        case 'block':
            const [ index, blockId ] = body
            const block = this._blocks[index][blockId]
            delete this._blocks[index][blockId]
            block.enter.resolve()
            await block.exit.promise
            break
        }
    }

    async _getPageAndParent (key, level, fork, entries) {
        const child = await this.descend(key, level, fork)
        entries.push.apply(entries, child.entries)
        const parent = this._descend(key, child.level - 1, 0)
        return { child, parent }
    }

    _index (id) {
        return id.split('.').reduce((sum, value) => sum + +value, 0) % this._appenders.length
    }

    append (entry, promises) {
        const queue = this._queue(entry.id)
        queue.writes.push(entry)
        if (promises[queue.id] == null) {
            promises[queue.id] = queue.promise
        }
    }

    _path (...vargs) {
        vargs.unshift(this.directory)
        return path.resolve.apply(path, vargs)
    }

    _nextId (leaf) {
        let id
        do {
            id = this._id++
        } while (id % 2 == leaf ? 1 : 0)
        return String(this.instance) + '.' +  String(id)
    }

    _filename (id) {
        return `${this.instance}.${this._id++}`
    }

    // TODO We need to block writes to the new page as well. Once we go async
    // again, someone could descend the tree and start writing to the new page
    // before we get a chance to write the new page stub.
    async _splitLeaf (key, lineage, entries) {
        const blockId = this._blockId = increment(this._blockId)
        const block = this._block(blockId, lineage.child.page.id)
        await block.enter.promise
        const pages = [ lineage.child.page ]
        const partition = Math.floor(pages[0].items.length / 2)
        const length = pages[0].items.length
        const items = lineage.child.page.items.splice(partition)
        const heft = items.reduce((sum, item) => sum + item.heft, 0)
        pages.push({
            id: this._nextId(true),
            leaf: true,
            items: items,
            right: lineage.child.page.right,
            heft: heft,
            append: this._filename()
        })
        pages[0].right = pages[1].items[0].key
        pages[1].items[0].key = null
        lineage.child.entry.heft = (pages[0].heft -= heft)
        const entry = this._hold(pages[1].id, pages[1])
        entries.push(entry)
        entry.heft = pages[1].heft
        const prepare = []
        const splice = [ lineage.parent.index + 1, 0, {
            key: pages[0].right,
            id: pages[1].id,
            heft: 0
        }]
        lineage.parent.page.items.splice.apply(lineage.parent.page.items, splice)
        pages.forEach(function (page) {
            if (page.items.length >= this.leaf.split) {
                this._housekeeping.add(page.items[0].key)
            }
        }, this)
        const writes = this._queue(lineage.child.page.id).writes.splice(0)
        await this._writeLeaf(lineage.child.page.id, writes)
        prepare.push([ 'stub', pages[1].id, pages[1].append, {
            method: 'splice',
            header: {
                index: partition,
                length: length,
                id: pages[0].id,
                append: pages[0].append
            }
        }])
        const append = this._filename()
        prepare.push([ 'stub', pages[0].id, append, {
            method: 'splice',
            header: {
                index: 0,
                length: partition,
                id: pages[0].id,
                append: pages[0].append
            }
        }])
        pages[0].append = append
        prepare.push([ 'commit' ])
        prepare.push([ 'splice', lineage.parent.page.id, splice ])
        const commit = new Commit(this)
        await commit.write(prepare)
        delete this._dirty[key]
        await commit.prepare()
        await commit.commit()
        block.exit.resolve()
        await commit.prepare()
        await commit.commit()
        entries.forEach(entry => entry.release())
        if (lineage.parent.page.items.length >= this.branch.split) {
            if (lineage.parent.page.id == '0.0') {
                await this._drainRoot()
            } else {
                await this._splitBranch(lineage.parent)
            }
        }
    }

    async _housekeeper (key) {
        const entries = []
        const lineage = await this._getPageAndParent(key, -1, 0, entries)
        if (lineage.child.page.items.length >= this.leaf.split) {
            await this._splitLeaf(key, lineage, entries)
        }
    }

    _tidy (key) {
        if (this._dirty[key] == null) {
            this._dirty[key] = true
            this._housekeeping.add(() => this._housekeeper(key))
        }
    }
}

module.exports = Journalist
