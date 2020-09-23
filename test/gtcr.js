
/* global describe, it, before, step */
const Web3 = require('web3')
const TruffleContract = require('@truffle/contract')
const { default: axios } = require('axios')
const delay = require('delay')
const fs = require('fs-extra')
const path = require('path')
const { ethers } = require('ethers')
const { gtcrEncode, ItemTypes } = require('@kleros/gtcr-encoder')
const { expect } = require('chai')
const { promisify } = require('util')
const _GeneralizedTCR = require('../build/contracts/GeneralizedTCR.json')
require('should')

const web3Provider = new Web3.providers.HttpProvider('http://localhost:8545')
const ethersProvider = new ethers.providers.JsonRpcProvider()
const web3 = new Web3(web3Provider)
const signer = ethersProvider.getSigner()

function getContract (contractName) {
  const C = TruffleContract(fs.readJsonSync(path.join(
    __dirname, '..', 'build', 'contracts', `${contractName}.json`
  )))
  C.setProvider(web3Provider)
  return C
}

const SimpleCentralizedArbitrator = getContract('SimpleCentralizedArbitrator')
const GTCRFactory = getContract('GTCRFactory')

async function queryGraph (query) {
  return (await axios.post('http://localhost:8000/subgraphs', { query })).data.data
}

const subgraphName = 'kleros/gtcr'

async function querySubgraph (query) {
  return (await axios.post(`http://localhost:8000/subgraphs/name/${subgraphName}`, { query })).data.data
}

async function waitForGraphSync (targetBlockNumber) {
  if (targetBlockNumber == null) { targetBlockNumber = await web3.eth.getBlockNumber() }

  while (true) {
    await delay(100)
    const {
      subgraphs: [{
        currentVersion: {
          id: currentVersionId,
          deployment: {
            latestEthereumBlockNumber
          }
        },
        versions: [{ id: latestVersionId }]
      }]
    } = await queryGraph(`{
      subgraphs(
        where: {name: "${subgraphName}"}
        first: 1
      ) {
        currentVersion {
          id
          deployment {
            latestEthereumBlockNumber
          }
        }
        versions(
          orderBy: createdAt,
          orderDirection: desc,
          first: 1
        ) {
          id
        }
      }
    }`)

    if (
      currentVersionId === latestVersionId &&
      latestEthereumBlockNumber.toString() === targetBlockNumber.toString()
    ) { break }
  }
}

/** Increases ganache time by the passed duration in seconds and mines a block.
 * @param {number} duration time in seconds
 */
async function increaseTime (duration) {
  await promisify(web3.currentProvider.send.bind(web3.currentProvider))({
    jsonrpc: '2.0',
    method: 'evm_increaseTime',
    params: [duration],
    id: new Date().getTime()
  })

  await advanceBlock()
}

/** Advance to next mined block using `evm_mine`
 * @returns {promise} Promise that block is mined
 */
function advanceBlock () {
  return promisify(web3.currentProvider.send.bind(web3.currentProvider))({
    jsonrpc: '2.0',
    method: 'evm_mine',
    id: new Date().getTime()
  })
}

describe('GTCR subgraph', function () {
  let centralizedArbitrator
  let gtcrFactory
  let gtcr

  let accounts
  let submitter
  before('get deployed contracts and accounts', async function () {
    [
      centralizedArbitrator,
      gtcrFactory,
      accounts
    ] = await Promise.all([
      SimpleCentralizedArbitrator.deployed(),
      await GTCRFactory.deployed(),
      await web3.eth.getAccounts()
    ])
    submitter = accounts[0]

    await gtcrFactory.deploy(
      centralizedArbitrator.address, // Arbitrator to resolve potential disputes. The arbitrator is trusted to support appeal periods and not reenter.
      '0x00', // Extra data for the trusted arbitrator contract.
      accounts[0], // Connected TCR is not used (any address here works for this test). // The address of the TCR that stores related TCR addresses. This parameter can be left empty.
      '', // The URI of the meta evidence object for registration requests.
      '', // The URI of the meta evidence object for clearing requests.
      accounts[0], // The trusted governor of this contract.
      0, // The base deposit to submit an item.
      0, // The base deposit to remove an item.
      0, // The base deposit to challenge a submission.
      0, // The base deposit to challenge a removal request.
      5, // The time in seconds parties have to challenge a request.
      [0, 0, 0], // Multipliers of the arbitration cost in basis points.
      { from: submitter }
    )
    const gtcrAddress = await gtcrFactory.instances(0)

    gtcr = new ethers.Contract(gtcrAddress, _GeneralizedTCR.abi, signer)
  })

  it('subgraph exists', async function () {
    const { subgraphs } = await queryGraph(`{
      subgraphs(first: 1, where: {name: "${subgraphName}"}) {
        id
      }
    }`)

    subgraphs.should.be.not.empty()
  })

  step('add item', async function () {
    const columns = [
      {
        label: 'Name',
        type: ItemTypes.TEXT
      },
      {
        label: 'Ticker',
        type: ItemTypes.TEXT
      }
    ] // This information can be found in the TCR meta evidence.
    const tokenData = {
      Name: 'Pinakion',
      Ticker: 'PNK'
    }

    const REGISTRATION_REQUESTED = 'RegistrationRequested'
    const REGISTERED = 'Registered'

    const arbitrationCost = await centralizedArbitrator.arbitrationCost('0x00')
    const encodedData = gtcrEncode({ columns, values: tokenData })

    await gtcr.addItem(encodedData, { from: submitter, value: arbitrationCost.toString() })

    const itemID = await gtcr.itemList(0)

    await advanceBlock()
    await waitForGraphSync()
    expect((await querySubgraph(`{
      item(id: "${itemID}") {
        id
        data
        status
      }
    }`)).item).to.deep.equal({ id: itemID, data: encodedData, status: REGISTRATION_REQUESTED })


    await increaseTime(10)
    await gtcr.executeRequest(itemID, { from: submitter })

    await advanceBlock()
    await waitForGraphSync()
    expect((await querySubgraph(`{
      item(id: "${itemID}") {
        status
      }
    }`)).item).to.deep.equal({ status: REGISTERED })
  })
})
