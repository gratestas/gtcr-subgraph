import { Bytes, log, BigInt, Address, ByteArray } from '@graphprotocol/graph-ts'
import { Item, Request, Round } from '../generated/schema'
import { AppealContribution, Dispute, GeneralizedTCR, HasPaidAppealFee, ItemStatusChange, ItemSubmitted, RequestEvidenceGroupID, RequestSubmitted, Ruling } from '../generated/templates/GeneralizedTCR/GeneralizedTCR'
import { IArbitrator } from '../generated/templates/IArbitrator/IArbitrator'

// Items on a TCR can be in 1 of 4 states:
// - (0) Absent: The item is not registered on the TCR and there are no pending requests.
// - (1) Registered: The item is registered and there are no pending requests.
// - (2) Registration Requested: The item is not registered on the TCR, but there is a pending
//       registration request.
// - (3) Clearing Requested: The item is registered on the TCR, but there is a pending removal
//       request. These are sometimes also called removal requests.
//
// Registration and removal requests can be challenged. Once the request resolves (either by
// passing the challenge period or via dispute resolution), the item state is updated to 0 or 1.


const ABSENT = "Absent"
const REGISTERED = "Registered"
const REGISTRATION_REQUESTED = "RegistrationRequested"
const CLEARING_REQUESTED = "ClearingRequested"

const NONE = "None"
const ACCEPT = "Accept"
const REJECT = "Reject"

const REQUESTER = "Requester"
const CHALLENGER = "Challenger"

const REQUESTER_CODE = 1
const CHALLENGER_CODE = 2

function getStatus(status: number): string {
  if (status == 0) return ABSENT
  if (status == 1) return REGISTERED
  if (status == 2) return REGISTRATION_REQUESTED
  if (status == 3) return CLEARING_REQUESTED
  return "Error"
}

function getWinner(outcome: number): string {
  if (outcome == 0) return NONE
  if (outcome == 1) return REQUESTER
  if (outcome == 2) return CHALLENGER
  return "Error"
}

function buildNewRound(roundID: string): Round {
  let newRound = new Round(roundID)
  newRound.amountPaidRequester = BigInt.fromI32(0)
  newRound.amountPaidChallenger = BigInt.fromI32(0)
  newRound.feeRewards = BigInt.fromI32(0)
  newRound.hasPaidRequester = false
  newRound.hasPaidChallenger = false
  return newRound
}

let ZERO_ADDRESS =
  Bytes.fromHexString("0x0000000000000000000000000000000000000000") as Bytes

export function handleRequestSubmitted(event: RequestEvidenceGroupID): void{
  let tcr = GeneralizedTCR.bind(event.address)
  let graphItemID = event.params._itemID.toHexString() + '@' + event.address.toHexString()
  let itemInfo = tcr.getItemInfo(event.params._itemID)

  let item = Item.load(graphItemID)
  if (item == null) {
    item = new Item(graphItemID)
    item.data = itemInfo.value0
    item.numberOfRequests = 1
    item.requests = []
  } else {
    item.numberOfRequests++
  }
  item.status = getStatus(itemInfo.value1)

  let requestID =
    graphItemID +
    '-' +
    itemInfo.value2.minus(BigInt.fromI32(1)).toString()

  let request = new Request(requestID)
  request.disputed = false
  request.arbitrator = tcr.arbitrator()
  request.arbitratorExtraData = tcr.arbitratorExtraData()
  request.challenger = ZERO_ADDRESS
  request.requester = event.transaction.from

  let metaEvidenceID = BigInt.fromI32(2).times(tcr.metaEvidenceUpdates())
  if (request.requestType == CLEARING_REQUESTED) {
    metaEvidenceID = metaEvidenceID.plus(BigInt.fromI32(1))
  }
  request.metaEvidenceID = metaEvidenceID
  request.winner = NONE
  request.resolved = false
  request.disputeID = 0
  request.submissionTime = event.block.timestamp
  request.numberOfRounds = 1
  request.requestType = item.status
  request.evidenceGroupID = event.params._evidenceGroupID

  let roundID = requestID + '-0'
  let round = new Round(roundID)

  let arbitrator = IArbitrator.bind(request.arbitrator as Address)
  if (request.requestType == REGISTRATION_REQUESTED) {
    round.amountPaidRequester = tcr.submissionBaseDeposit()
      .plus(
        arbitrator.arbitrationCost(request.arbitratorExtraData)
      )
  } else {
    round.amountPaidRequester = tcr.removalBaseDeposit()
      .plus(
        arbitrator.arbitrationCost(request.arbitratorExtraData)
      )
  }

  round.feeRewards = round.amountPaidRequester
  round.amountPaidChallenger = BigInt.fromI32(0)
  round.hasPaidRequester = true
  round.hasPaidChallenger = false
  round.save()

  request.rounds =[round.id]
  request.save()

  // Cannot push to item.requests directly so we use
  // a temporary variable.
  let itemRequests = item.requests
  itemRequests.push(request.id)
  item.requests = itemRequests

  item.save()
}

export function handleRequestResolved(event: ItemStatusChange): void {
  if (event.params._resolved == false) return // No-op.

  let graphItemID = event.params._itemID.toHexString() + '@' + event.address.toHexString()
  let tcrAddress = event.address.toHexString()

  let tcr = GeneralizedTCR.bind(event.address)
  let itemInfo = tcr.getItemInfo(event.params._itemID)

  let item = Item.load(graphItemID)
  if (item == null) {
    log.error(
      'GTCR: Item {} @ {} not found. Bailing handleRequestResolved.',
      [event.params._itemID.toHexString(), tcrAddress]
    )
    return
  }

  item.status = getStatus(itemInfo.value1)
  item.save()

  let requestInfo = tcr.getRequestInfo(event.params._itemID, event.params._requestIndex)

  let request = Request.load(graphItemID + '-' + event.params._requestIndex.toString())
  if (request == null) {
    log.error(
      'GTCR: Request {} of item {} of TCR {} not found. Bailing.',
      [
        event.params._requestIndex.toString(),
        event.params._itemID.toHexString(),
        tcrAddress
      ]
    )
    return
  }
  request.resolved = true
  request.winner = getWinner(requestInfo.value6)

  request.save()
}

export function handleRequestChallenged(event: Dispute): void {
  let tcr = GeneralizedTCR.bind(event.address)
  let itemID = tcr.arbitratorDisputeIDToItem(
    event.params._arbitrator,
    event.params._disputeID
  )
  let graphItemID = itemID.toHexString() + '@' + event.address.toHexString()
  let item = Item.load(graphItemID)
  if (item == null) {
    log.error(
      'GTCR: Item {} not found. Bailing handleRequestResolved.',
      [graphItemID]
    )
    return
  }

  let itemInfo = tcr.getItemInfo(itemID)
  let requestID = graphItemID
    + '-'
    + itemInfo.value2.minus(BigInt.fromI32(1)).toString()
  let request = Request.load(requestID)
  request.disputed = true

  let requestInfo = tcr.getRequestInfo(itemID, itemInfo.value2.minus(BigInt.fromI32(1)))
  let roundID = requestID + '-' + requestInfo.value5.minus(BigInt.fromI32(2)).toString()
  let round = Round.load(roundID)
  let arbitrator = IArbitrator.bind(request.arbitrator as Address)
  let arbitrationCost = arbitrator.arbitrationCost(request.arbitratorExtraData)
  if (request.requestType == REGISTRATION_REQUESTED)
    round.amountPaidChallenger = tcr
      .submissionChallengeBaseDeposit()
      .plus(arbitrationCost)
  else
    round.amountPaidChallenger = tcr
      .removalChallengeBaseDeposit()
      .plus(arbitrationCost)

  round.feeRewards = round.feeRewards
    .plus(round.amountPaidChallenger)
    .minus(arbitrationCost)
  round.hasPaidChallenger = true
  round.save()

  let newRoundID = requestID + '-' + requestInfo.value5.minus(BigInt.fromI32(1)).toString()
  let newRound = buildNewRound(newRoundID)
  newRound.save()

  let rounds = request.rounds
  rounds.push(newRound.id)
  request.rounds = rounds
  request.save()
}

export function handleAppealContribution(event: AppealContribution): void {
  let tcr = GeneralizedTCR.bind(event.address)
  let graphItemID = event.params._itemID.toHexString() + '@' + event.address.toHexString()
  let item = Item.load(graphItemID)
  if (item == null) {
    log.error(
      'GTCR: Item {} @ {} not found. Bailing handleRequestResolved.',
      [event.params._itemID.toHexString(), event.address.toHexString()]
    )
    return
  }

  let itemInfo = tcr.getItemInfo(event.params._itemID)
  let requestID = graphItemID + '-' + itemInfo.value2.minus(BigInt.fromI32(1)).toString()

  let requestInfo = tcr.getRequestInfo(event.params._itemID, itemInfo.value2.minus(BigInt.fromI32(1)))
  let roundID = requestID + '-' + requestInfo.value5.minus(BigInt.fromI32(1)).toString()
  let round = Round.load(roundID)
  if (event.params._side == REQUESTER_CODE) {
    round.amountPaidRequester = round.amountPaidRequester.plus(event.params._amount)
  } else {
    round.amountPaidChallenger = round.amountPaidChallenger.plus(event.params._amount)
  }

  round.save()
}

export function handleHasPaidAppealFee(event: HasPaidAppealFee): void {
  let tcr = GeneralizedTCR.bind(event.address)
  let graphItemID = event.params._itemID.toHexString() + '@' + event.address.toHexString()
  let item = Item.load(graphItemID)
  if (item == null) {
    log.error(
      'GTCR: Item {} @ {} not found. Bailing handleRequestResolved.',
      [event.params._itemID.toHexString(), event.address.toHexString()]
    )
    return
  }

  let itemInfo = tcr.getItemInfo(event.params._itemID)
  let requestID = graphItemID + '-' +
    itemInfo.value2.minus(BigInt.fromI32(1)).toString()

  let requestInfo = tcr.getRequestInfo(
    event.params._itemID,
    itemInfo.value2.minus(BigInt.fromI32(1))
  )
  let roundID = requestID + '-'
    + requestInfo.value5.minus(BigInt.fromI32(1)).toString()
  let round = Round.load(roundID)
  if (event.params._side == REQUESTER_CODE) {
    round.hasPaidRequester = true
  } else {
    round.hasPaidRequester = true
  }

  if (round.hasPaidChallenger && round.hasPaidChallenger) {
    let request = Request.load(graphItemID + '-' + event.params._request.toString())
    let arbitrator = IArbitrator.bind(request.arbitrator as Address)
    let appealCost = arbitrator.appealCost(
      BigInt.fromI32(request.disputeID),
      request.arbitratorExtraData
    )
    round.feeRewards = round.feeRewards.minus(appealCost)

    let newRoundID = requestID + '-' + requestInfo.value5.minus(BigInt.fromI32(1)).toString()
    let newRound = buildNewRound(newRoundID)
    newRound.save()

    let rounds = request.rounds
    rounds.push(newRoundID)
    request.rounds = rounds
    request.save()
  }

  round.save()
}

export function handleRuling(event: Ruling): void {

}