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

export interface AmazonOrderDetails {
  orderId: string
  orderUrl: string
  orderDate?: string
  status?: string
  items: AmazonOrderItem[]
}

export async function getOrderDetails(orderIdOrUrl: string): Promise<AmazonOrderDetails> {
  const orderId = extractOrderId(orderIdOrUrl)
  const domain = getAmazonDomain()

  let html = ''
  let sourceUrl = ''

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
  const status = normalizeText($('h4.od-status-message .a-text-bold').first().text()) || undefined
  const items = extractOrderDetailItems($)

  return {
    orderId,
    orderUrl: sourceUrl || `https://www.${domain}/your-orders/order-details?orderID=${orderId}`,
    orderDate,
    status,
    items,
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
