import { getTransactions } from './transactions.js'

async function main() {
  try {
    const transactions = await getTransactions({ maxPages: 1, limit: 5 })
    console.log('getTransactions result:')
    console.log(JSON.stringify(transactions, null, 2))
  } catch (error) {
    console.error('Error fetching transactions:', error)
  }
}
main().catch(console.error)
