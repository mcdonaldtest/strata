require('proof')(3, async (okay) => {
    const Destructible = require('destructible')

    const Strata = require('../strata')
    const Cache = require('../cache')

    const utilities = require('../utilities')
    const path = require('path')
    const directory = path.join(utilities.directory, 'merge')
    await utilities.reset(directory)
    await utilities.serialize(directory, {
        '0.0': [[ '0.1', null ], [ '0.3', 'd' ]],
        '0.1': [[
            'right', '0.3'
        ], [
            'insert', 0, 'a'
        ], [
            'insert', 1, 'b'
        ], [
            'insert', 2, 'c'
        ]],
        '0.3': [[
            'insert', 0, 'd'
        ], [
            'insert', 1, 'e'
        ]]
    })

    // Merge.
    {
        const cache = new Cache
        const strata = new Strata(new Destructible('merge'), { directory, cache })
        await strata.open()
        const writes = {}
        const cursor = await strata.search('e')
        const { index } = cursor.indexOf('e')
        // TODO Come back and insert an error into `remove`. Then attempt to
        // resolve that error somehow into `flush`. Implies that Turnstile
        // propagates an error. Essentially, how do you get the foreground to
        // surrender when the background has failed. `flush` could be waiting on
        // a promise when the background fails and hang indefinately. Any one
        // error, like a `shutdown` error would stop it.
        cursor.remove(index, writes)
        cursor.release()
        Strata.flush(writes)
        await strata.destructible.destroy().rejected
        cache.purge(0)
        okay(cache.heft, 0, 'cache purged')
    }
    // Reopen.
    {
        const cache = new Cache
        const strata = new Strata(new Destructible('reopen'), { directory, cache })
        await strata.open()
        const cursor = await strata.search('d')
        const { index } = cursor.indexOf('d')
        okay(cursor.page.items[index].parts[0], 'd', 'found')
        cursor.release()
        await strata.destructible.destroy().rejected
    }
    // Traverse.
    {
        const cache = new Cache
        const strata = new Strata(new Destructible('traverse'), { directory, cache })
        await strata.open()
        let right = 'a'
        const items = []
        do {
            const cursor = await strata.search(right)
            const { index } = cursor.indexOf(right)
            for (let i = index; i < cursor.page.items.length; i++) {
                items.push(cursor.page.items[i].parts[0])
            }
            cursor.release()
            right = cursor.page.right
        } while (right != null)
        okay(items, [ 'a', 'b', 'c', 'd' ], 'traverse')
        await strata.destructible.destroy().rejected
    }
})
