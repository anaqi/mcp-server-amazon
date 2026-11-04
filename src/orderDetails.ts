import * as cheerio from 'cheerio'
import fs from 'fs'
import { USE_MOCKS, EXPORT_LIVE_SCRAPING_FOR_MOCKS, getAmazonDomain } from './config.js'
import { createBrowserAndPage, getTimestamp, throwIfNotLoggedIn } from './utils.js'

const __dirname = new URL('.', import.meta.url).pathname

export interface AmazonOrderItem {
  title: string
  image?: string
  productUrl?: string
  asin?: string | null
}

export interface AmazonTrackingEvent {
  date: string
  time: string | null
  message: string
  location: string | null
}

export interface AmazonShipment {
  carrier: string | null
  trackingId: string | null
  /** Delivery promise, e.g. "Arriving Saturday" or "Estimated to arrive by 4 November" */
  status: string | null
  /** Progress milestone, e.g. "Shipped" (only on some tracker layouts) */
  stage: string | null
  /** Amazon's delay / exception message, when present */
  note: string | null
  trackUrl: string
  /** Newest first, as Amazon displays them. Dates have no year; times are local. */
  events: AmazonTrackingEvent[]
}

export interface AmazonOrderDetails {
  orderId: string
  orderUrl: string
  orderDate?: string
  status?: string
  items: AmazonOrderItem[]
  /** One entry per package that has a "Track package" link; empty if not shipped yet. */
  shipments: AmazonShipment[]
}

export async function getOrderDetails(orderIdOrUrl: string): Promise<AmazonOrderDetails> {
  const orderId = extractOrderId(orderIdOrUrl)
  const domain = getAmazonDomain()

  let html = ''
  let sourceUrl = ''
  let shipments: AmazonShipment[] = []

  if (USE_MOCKS) {
    console.error('[INFO][get-order-details] Fetching order details from mocks')
    const mockPath = `${__dirname}/../mocks/getOrderDetails.html`
    html = fs.readFileSync(mockPath, 'utf-8')
    sourceUrl = `https://www.${domain}/your-orders/order-details?orderID=${orderId}`
  } else {
    const { browser, page } = await createBrowserAndPage()
    const urlCandidates = buildOrderDetailsUrls(domain, orderId)

    try {
      for (const url of urlCandidates) {
        console.error(`[INFO][get-order-details] Fetching order details from ${url}`)

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 })

        if (await isSignInPage(page)) {
          console.error(`[INFO][get-order-details] Amazon redirected to sign in for ${url}`)
          continue
        }

        if (!(await hasOrderDetailsContent(page))) {
          console.error(`[INFO][get-order-details] No order details content detected for ${url}`)
          continue
        }

        await throwIfNotLoggedIn(page)
        html = await page.content()
        sourceUrl = page.url()

        if (EXPORT_LIVE_SCRAPING_FOR_MOCKS) {
          const timestamp = getTimestamp()
          const mockPath = `${__dirname}/../mocks/getOrderDetails_${timestamp}.html`
          fs.writeFileSync(mockPath, html)
          console.error(`[INFO][get-order-details] Exported order details HTML to ${mockPath}`)
        }

        // Tracker pages are only reachable from a live, logged-in session, so fetch them
        // before the browser closes.
        shipments = await fetchShipments(page, extractTrackUrls(cheerio.load(html), page.url()))
        break
      }
    } finally {
      await browser.close()
    }
  }

  if (!html) {
    throw new Error(
      `Unable to load order details for ${orderId}. Amazon redirected to sign-in or did not expose the order content.`
    )
  }

  const $ = cheerio.load(html)
  const orderDate = normalizeText($('[data-component="orderDate"] span').first().text()) || undefined
  const status =
    normalizeText($('[data-component="shipmentStatus"]').first().text()) ||
    normalizeText($('h4.od-status-message').first().text()) ||
    undefined
  const items = extractOrderDetailItems($)

  return {
    orderId,
    orderUrl: sourceUrl || `https://www.${domain}/your-orders/order-details?orderID=${orderId}`,
    orderDate,
    status,
    items,
    shipments,
  }
}

type Page = Awaited<ReturnType<typeof createBrowserAndPage>>['page']

/** "Track package" links on an order details page (one per package). */
export function extractTrackUrls($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const urls: string[] = []
  $('a[href*="progress-tracker/package"]').each((_i, a) => {
    const href = ($(a).attr('href') || '').replace(/&amp;/g, '&')
    if (!href) return
    const abs = new URL(href, baseUrl).toString()
    if (!urls.includes(abs)) urls.push(abs)
  })
  return urls
}

async function fetchShipments(page: Page, trackUrls: string[]): Promise<AmazonShipment[]> {
  const shipments: AmazonShipment[] = []
  for (const trackUrl of trackUrls) {
    try {
      console.error(`[INFO][get-order-details] Fetching tracking from ${trackUrl}`)
      await page.goto(trackUrl, { waitUntil: 'networkidle2', timeout: 45000 })
      if (await isSignInPage(page)) {
        console.error('[INFO][get-order-details] Tracker redirected to sign in')
        continue
      }
      const trackerHtml = await page.content()
      if (EXPORT_LIVE_SCRAPING_FOR_MOCKS) {
        const mockPath = `${__dirname}/../mocks/getTracking_${getTimestamp()}.html`
        fs.writeFileSync(mockPath, trackerHtml)
        console.error(`[INFO][get-order-details] Exported tracker HTML to ${mockPath}`)
      }
      shipments.push(parseTrackingPage(trackerHtml, trackUrl))
    } catch (error: any) {
      // Tracking is best-effort: never fail the whole order lookup because of it.
      console.error(`[ERROR][get-order-details] Failed to fetch tracking ${trackUrl}: ${error.message}`)
    }
  }
  return shipments
}

/**
 * Parse an Amazon progress-tracker page. Amazon serves two different top-level layouts
 * (Amazon Logistics vs third-party carrier), but both embed the same "See all updates"
 * popover (#tracking-events-container), which is the source for carrier, id and history.
 */
export function parseTrackingPage(html: string, trackUrl: string): AmazonShipment {
  const $ = cheerio.load(html)
  const text = (sel: string) => normalizeText($(sel).first().text())
  const root = $('#tracking-events-container')

  const carrier =
    normalizeText(root.find('.tracking-event-carrier-header').first().text()) ||
    text('#carrierRelatedInfo-container h1') ||
    text('.pt-delivery-card-wrapper h3')
  const trackingId =
    normalizeText(root.find('.tracking-event-trackingId-text').first().text()) ||
    text('.carrierRelatedInfo-trackingId-text') ||
    text('.pt-delivery-card-trackingId')

  const events: AmazonTrackingEvent[] = []
  root.find('.tracking-event-date-header').each((_i, header) => {
    const date = normalizeText($(header).find('.tracking-event-date').text())
    $(header)
      .parent()
      .find('.tracking-event-time-left')
      .each((_j, left) => {
        const right = $(left).next('.tracking-event-time-right')
        events.push({
          date,
          time: normalizeText($(left).find('.tracking-event-time').text()) || null,
          message: normalizeText(right.find('.tracking-event-message').text()),
          location: normalizeText(right.find('.tracking-event-location').text()) || null,
        })
      })
  })

  return {
    carrier: carrier.replace(/^Delivery by\s*/i, '') || null,
    trackingId: trackingId.replace(/^Tracking ID:\s*/i, '') || null,
    status: text('#primaryStatus') || text('.pt-promise-main-slot') || null,
    stage: text('.pt-status-main-status') || null,
    note: text('#lexicalExceptionMessage-container h3') || null,
    trackUrl: trackUrl.replace(/&(vt|ref_|noPtRedirect)=[^&]*/g, ''),
    events,
  }
}

function buildOrderDetailsUrls(domain: string, orderId: string): string[] {
  return [
    `https://www.${domain}/your-orders/order-details?orderID=${orderId}`,
    `https://www.${domain}/gp/css/order-details?orderID=${orderId}`,
    `https://www.${domain}/-/en/your-orders/order-details?orderID=${orderId}`,
    `https://www.${domain}/-/en/gp/css/order-details?orderID=${orderId}`,
  ]
}

function extractOrderId(orderIdOrUrl: string): string {
  const normalized = orderIdOrUrl.trim()
  const urlMatch = normalized.match(/orderID=([0-9]{3}-[0-9]{7}-[0-9]{7})/i)
  if (urlMatch) return urlMatch[1]

  const idMatch = normalized.match(/\b[0-9]{3}-[0-9]{7}-[0-9]{7}\b/)
  if (idMatch) return idMatch[0]

  throw new Error('Order ID must look like 702-1234567-1234567 or be a URL containing orderID=...')
}

function extractOrderDetailItems($: cheerio.CheerioAPI): AmazonOrderItem[] {
  const items: AmazonOrderItem[] = []
  const seen = new Set<string>()

  $('[data-component="purchasedItems"]').each((_i, container) => {
    const $c = $(container)
    const titleAnchor = $c.find('[data-component="itemTitle"] a').first()
    const imageEl = $c.find('[data-component="itemImage"] img').first()
    const imageAnchor = $c.find('[data-component="itemImage"] a').first()

    const title = normalizeText(titleAnchor.text()) || normalizeText(imageEl.attr('alt') || '')
    const productUrl = titleAnchor.attr('href') || imageAnchor.attr('href') || undefined
    const image = imageEl.attr('data-a-hires') || imageEl.attr('src') || undefined
    const asin = extractAsin(productUrl)

    if (!title && !productUrl) return

    const key = [title, productUrl || '', asin || ''].join('|')
    if (seen.has(key)) return
    seen.add(key)

    items.push({ title, image, productUrl, asin })
  })

  return items
}

function extractAsin(url?: string | null): string | null {
  if (!url) return null
  const cleanUrl = url.replace(/&amp;/g, '&')
  const dpMatch = cleanUrl.match(/\/dp\/([A-Z0-9]{10})/i)
  if (dpMatch) return dpMatch[1]
  const asinMatch = cleanUrl.match(/[?&]asin=([A-Z0-9]{10})/i)
  if (asinMatch) return asinMatch[1]
  return null
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

async function isSignInPage(page: Awaited<ReturnType<typeof createBrowserAndPage>>['page']): Promise<boolean> {
  return (await page.$('#ap_email')) !== null || (await page.$('#signInSubmit')) !== null
}

async function hasOrderDetailsContent(page: Awaited<ReturnType<typeof createBrowserAndPage>>['page']): Promise<boolean> {
  return (await page.$('[data-component="purchasedItems"]')) !== null
}
