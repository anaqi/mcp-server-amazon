import * as cheerio from 'cheerio'
import fs from 'fs'
import { USE_MOCKS, getAmazonDomain } from './config.js'
import { createBrowserAndPage, throwIfNotLoggedIn } from './utils.js'

const __dirname = new URL('.', import.meta.url).pathname

export interface AmazonTransaction {
  section: 'In progress' | 'Completed' | string
  date: string
  paymentMethod: string
  cardLast4?: string
  amount: string
  amountType: 'charge' | 'credit' | 'unknown'
  status?: string
  orderNumber?: string
  orderUrl?: string
  merchant?: string
  description?: string
}

export interface GetTransactionsOptions {
  maxPages?: number
  limit?: number
}

// ##################################
// Get Transactions
// ##################################

export async function getTransactions(options: GetTransactionsOptions = {}): Promise<AmazonTransaction[]> {
  const maxPages = normalizePositiveInteger(options.maxPages, 1, 20) ?? 1
  const limit = normalizePositiveInteger(options.limit, undefined, 500)

  let htmlPages: string[]
  if (USE_MOCKS) {
    console.error('[INFO][get-transactions] Fetching transactions from mocks')
    const mockPath = `${__dirname}/../mocks/getTransactions.html`
    htmlPages = [fs.readFileSync(mockPath, 'utf-8')]
  } else {
    const domain = getAmazonDomain()
    const url = `https://www.${domain}/cpe/yourpayments/transactions`
    console.error(`[INFO][get-transactions] Fetching transactions from ${url}`)

    const { browser, page } = await createBrowserAndPage()

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 })
      await throwIfNotLoggedIn(page)

      htmlPages = await collectTransactionPages(page, maxPages)
    } finally {
      await browser.close()
    }
  }

  const transactions = htmlPages.flatMap(html => extractTransactionsPageData(cheerio.load(html)))
  console.error(`[INFO][get-transactions] Extracted ${transactions.length} transaction(s) from ${htmlPages.length} page(s)`)
  return typeof limit === 'number' ? transactions.slice(0, limit) : transactions
}

async function collectTransactionPages(page: Awaited<ReturnType<typeof createBrowserAndPage>>['page'], maxPages: number): Promise<string[]> {
  const htmlPages: string[] = []

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    try {
      await page.waitForSelector('.apx-transactions-line-item-component-container, .contentLoadError', { timeout: 15000 })
    } catch (e) {
      throw new Error(
        '[INFO][get-transactions] Could not find transactions. Ensure you are logged in and Your Payments transactions are accessible.'
      )
    }

    htmlPages.push(await page.content())

    if (pageIndex >= maxPages - 1) break

    const beforeSignature = await getFirstTransactionSignature(page)
    const clicked = await clickNextTransactionsPage(page)

    if (!clicked) {
      console.error(`[INFO][get-transactions] No Next page button found after ${pageIndex + 1} page(s)`)
      break
    }

    try {
      await page.waitForFunction(
        signature => {
          const first = document.querySelector('.apx-transactions-line-item-component-container')?.textContent?.replace(/\s+/g, ' ').trim() || ''
          return first.length > 0 && first !== signature
        },
        { timeout: 20000 },
        beforeSignature
      )
    } catch (error) {
      console.error(`[INFO][get-transactions] Next page did not load after ${pageIndex + 1} page(s): ${error}`)
      break
    }
  }

  return htmlPages
}

async function getFirstTransactionSignature(page: Awaited<ReturnType<typeof createBrowserAndPage>>['page']): Promise<string> {
  return page.$$eval(
    '.apx-transactions-line-item-component-container',
    elements => elements[0]?.textContent?.replace(/\s+/g, ' ').trim() || ''
  )
}

async function clickNextTransactionsPage(page: Awaited<ReturnType<typeof createBrowserAndPage>>['page']): Promise<boolean> {
  return page.evaluate(() => {
    const input = document.querySelector(
      '#portalWidgetSection input[name*="DefaultNextPageNavigationEvent"]:not([disabled])'
    ) as HTMLInputElement | null

    if (!input) return false

    input.click()
    return true
  })
}

export function extractTransactionsPageData($: cheerio.CheerioAPI): AmazonTransaction[] {
  const transactions: AmazonTransaction[] = []
  let currentSection = ''
  let currentDate = ''

  $('.apx-transactions-sleeve-header-container, .apx-transaction-date-container, .apx-transactions-line-item-component-container').each(
    (_index, element) => {
      const $element = $(element)

      if ($element.hasClass('apx-transactions-sleeve-header-container')) {
        currentSection = normalizeText($element.text())
        return
      }

      if ($element.hasClass('apx-transaction-date-container')) {
        currentDate = normalizeText($element.text())
        return
      }

      const transaction = extractTransactionLineItem($, $element, currentSection, currentDate)
      if (transaction) transactions.push(transaction)
    }
  )

  return transactions
}

function extractTransactionLineItem(
  $: cheerio.CheerioAPI,
  $item: cheerio.Cheerio<any>,
  section: string,
  date: string
): AmazonTransaction | null {
  const paymentRowText = normalizeText($item.find('.a-row').first().text())
  const amount = extractAmount(paymentRowText)
  const paymentMethod = amount ? paymentRowText.slice(0, paymentRowText.indexOf(amount)).trim() : paymentRowText

  const detailTexts = $item
    .find('.a-section.a-spacing-none.a-spacing-top-mini')
    .map((_index, element) => normalizeText($(element).text()))
    .get()
    .filter(Boolean)

  const status = $item
    .find('.a-row')
    .map((_index, element) => normalizeText($(element).text()))
    .get()
    .find(text => /^(pending|completed|declined|cancelled|failed)$/i.test(text))

  const description = detailTexts.find(text => /order #|refund/i.test(text))
  const merchant = detailTexts.find(text => !/order #|refund/i.test(text))
  const orderNumber = extractOrderNumber(detailTexts.join(' '))
  const orderUrl = orderNumber ? $item.find(`a[href*="${orderNumber}"]`).attr('href') : undefined
  const cardLast4 = extractCardLast4(paymentMethod)

  if (!paymentMethod && !amount && detailTexts.length === 0) {
    return null
  }


  return {
    section,
    date,
    paymentMethod,
    cardLast4,
    amount: amount || '',
    amountType: getAmountType(amount),
    status,
    orderNumber,
    orderUrl,
    merchant,
    description,
  }
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function extractAmount(text: string): string | undefined {
  return text.match(/[+-]\s*(?:CA\$|\$)\s*\d[\d,]*(?:\.\d{2})?/)?.[0]?.replace(/\s+/g, '')
}

function getAmountType(amount: string | undefined): AmazonTransaction['amountType'] {
  if (!amount) return 'unknown'
  if (amount.startsWith('+')) return 'credit'
  if (amount.startsWith('-')) return 'charge'
  return 'unknown'
}

function extractOrderNumber(text: string): string | undefined {
  return text.match(/\b\d{3}-\d{7}-\d{7}\b/)?.[0]
}

function extractCardLast4(paymentMethod: string): string | undefined {
  return paymentMethod.match(/\*{2,}\s?(\d{4})\b/)?.[1]
}

function normalizePositiveInteger(value: number | undefined, defaultValue: number | undefined, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultValue
  return Math.min(Math.max(Math.floor(value), 1), max)
}
