import assert from 'node:assert/strict'
import fs from 'fs'
import * as cheerio from 'cheerio'
import { extractTrackUrls, parseTrackingPage } from './orderDetails.js'

const __dirname = new URL('.', import.meta.url).pathname
const mock = (name: string) => fs.readFileSync(`${__dirname}/../mocks/${name}`, 'utf-8')
const base = 'https://www.amazon.ca/progress-tracker/package?orderId=701-0000000-0000000&shipmentId=TESTSHIP&packageIndex=0'

// Amazon Logistics layout (with a delay note and multi-event history)
const amazon = parseTrackingPage(mock('getTracking_amazon.html'), `${base}&vt=NOTIFICATIONS&noPtRedirect=1`)
assert.equal(amazon.carrier, 'Amazon')
assert.equal(amazon.trackingId, 'TBC000000000000')
assert.match(amazon.status ?? '', /^Estimated to arrive by/)
assert.match(amazon.note ?? '', /delay/i)
assert.equal(amazon.trackUrl, base, 'noise params stripped from trackUrl')
assert.equal(amazon.events.length, 3)
assert.deepEqual(amazon.events[0], {
  date: 'Tuesday, 3 November',
  time: '11:30 a.m.',
  message: 'Package left the carrier facility.',
  location: 'Whitby, CA',
})
assert.equal(amazon.events[2].time, null)
assert.equal(amazon.events[2].location, null)

// Third-party carrier layout
const tp = parseTrackingPage(mock('getTracking_thirdparty.html'), base)
assert.equal(tp.carrier, 'Intelcom Courrier Canada Inc.')
assert.equal(tp.trackingId, 'INTLCMJ000000000')
assert.match(tp.status ?? '', /^Arriving/)
assert.equal(tp.stage, 'Shipped')
assert.equal(tp.note, null)
assert.equal(tp.events.length, 1)

// Track links on the order details page
const urls = extractTrackUrls(cheerio.load(mock('getOrderDetails_shipped.html')), 'https://www.amazon.ca/your-orders/order-details')
assert.equal(urls.length, 1)
assert.ok(urls[0].startsWith('https://www.amazon.ca/progress-tracker/package?'))
assert.ok(!urls[0].includes('&amp;'))

console.log('orderTracking: all assertions passed')
