import 'isomorphic-fetch'
import { Zilliqa } from '@zilliqa-js/zilliqa'
import { Wallet, Transaction, TxReceipt as _TxReceipt } from '@zilliqa-js/account'
import { Contract, Value, CallParams } from '@zilliqa-js/contract'
import { fromBech32Address, toBech32Address } from '@zilliqa-js/crypto'
import { StatusType, MessageType, NewEventSubscription } from '@zilliqa-js/subscriptions'
import { BN, Long, units } from '@zilliqa-js/util'
import { BigNumber } from 'bignumber.js'
import { Mutex } from 'async-mutex'

import {
  APIS,
  WSS,
  CONTRACTS,
  REGISTER,
  LAUNCHER,
  HEX,
  DEX,
  HASH,
  HUSD,
  CHAIN_VERSIONS,
  BASIS,
  Network,
  ZIL_HASH,
  HUSD_HASH,
  HASH_HASH,
  ZERO_HASH,
} from './constants'
import { unitlessBigNumber, toPositiveQa, isLocalStorageAvailable } from './utils'
import { sendBatchRequest, BatchRequest, BatchResponse } from './batch'

import { Options, OnUpdate, ObservedTx, TxStatus, TxReceipt, TxParams, Rates, WalletProvider, RPCBalanceResponse } from './index'
import { Zilo, OnStateUpdate } from './zilo'

export * as Zilo from './zilo'

BigNumber.config({ EXPONENTIAL_AT: 1e9 }) // never!

const bigZero = new BigNumber(0)

export type TokenDetails = {
  contract: Contract // instance
  address: string
  hash: string
  name: string
  symbol: string
  decimals: number
  registered: boolean // is in default token list
  whitelisted: boolean // is a verified token
}

export type ContractState = {
  influencer: { [key in string]?: string }
  launchs: { [key in string]?: { arguments: ReadonlyArray<string> } }
  sponsors: { [key in string]?: { [key2 in string]?: { arguments: ReadonlyArray<any> } } }
  zero_sponsor: { [key in string]?: { [key2 in string]?: { arguments: ReadonlyArray<any> } } }
  total_sponsorship: { [key in string]?: string }

  balances: { [key in string]?: { [key2 in string]?: { arguments: ReadonlyArray<any> } } }
  output_after_fee: string
  pools: { [key in string]?: { arguments: ReadonlyArray<string> } }
  total_contributions: { [key in string]?: string }
}

export type AppState = {
  contractState: ContractState
  tokens: { [key in string]: TokenDetails }
  pools: { [key in string]?: Pool }
  currentUser: string | null
  currentNonce: number | null
  currentBalance: BigNumber | null
}

export type SponsorToken = {
  sponsorHusd: BigNumber
  removeHusd: BigNumber
  transactionFee: BigNumber
  entryBlock: BigNumber
  lockIn: BigNumber
}

export enum LaunchState {
  Undefined = 'Undefined',
  Validation = 'Validation',
  Open = 'Open',
  ToLaunch = 'ToLaunch',
  Launched = 'Launched',
  OnHold = 'OnHold',
  Dissolve = 'Dissolve',
}

export type Pool = {
  hashSponsorship: BigNumber
  tokenSponsorship: BigNumber
  targetRate: BigNumber // price set by influencer
  deadline: BigNumber
  state: LaunchState
  userSponsor: SponsorToken
  zeroSponsor: SponsorToken
  totalSponsor: BigNumber

  zilReserve: BigNumber
  tokenReserve: BigNumber
  exchangeRate: BigNumber // the zero slippage exchange rate
  totalContribution: BigNumber
  userContribution: BigNumber
  userEntryBlock: BigNumber
  contributionPercentage: BigNumber
}

export class Hex {
  /* Zilliqa SDK */
  readonly zilliqa: Zilliqa

  /* Internals */
  private readonly rpcEndpoint: string
  private readonly walletProvider?: WalletProvider // zilpay
  private readonly tokens: { [key in string]: string } // symbol => hash mappings
  private appState?: AppState // cached blockchain state for dApp and user

  /* Txn observers */
  private subscription: NewEventSubscription | null = null
  private observer: OnUpdate | null = null
  private observerMutex: Mutex
  private observedTxs: ObservedTx[] = []

  /* Deadline tracking */
  private deadlineBuffer: number = 3
  private currentBlock: number = -1

  /* HEX contract attributes */
  readonly contract: Contract
  readonly contractAddress: string
  readonly contractHash: string

  /* DEX contract attributes */
  readonly hashContract: Contract
  readonly hashContractAddress: string
  readonly hashContractHash: string

  /* HASH contract attributes */
  readonly husdContract: Contract
  readonly husdContractAddress: string
  readonly husdContractHash: string

  /* DEX contract attributes */
  readonly dexContract: Contract
  readonly dexContractAddress: string
  readonly dexContractHash: string

  /* LAUNCHER contract attributes */
  readonly launcherContract: Contract
  readonly launcherContractAddress: string
  readonly launcherContractHash: string

  /* REGSITER contract attributes */
  readonly registerContract: Contract
  readonly registerContractAddress: string
  readonly registerContractHash: string

  /* Zilswap initial launch offerings */
  readonly zilos: { [address: string]: Zilo }

  /* Transaction attributes */
  readonly _txParams: TxParams = {
    version: -1,
    gasPrice: new BN(0),
    gasLimit: Long.fromNumber(5000),
  }

  /**
   * Creates the Zilswap SDK object. {@linkcode initalize} needs to be called after
   * the object is created to begin watching the blockchain's state.
   *
   * @param network the Network to use, either `TestNet` or `MainNet`.
   * @param walletProviderOrKey a Provider with Wallet or private key string to be used for signing txns.
   * @param options a set of Options that will be used for all txns.
   */
  constructor(readonly network: Network, walletProviderOrKey?: WalletProvider | string, options?: Options) {
    console.log('SDK ----- INITIALIZE ----- 1')
    this.rpcEndpoint = options?.rpcEndpoint || APIS[network]
    if (typeof walletProviderOrKey === 'string') {
      this.zilliqa = new Zilliqa(this.rpcEndpoint)
      this.zilliqa.wallet.addByPrivateKey(walletProviderOrKey)
    } else if (walletProviderOrKey) {
      this.zilliqa = new Zilliqa(this.rpcEndpoint, walletProviderOrKey.provider)
      this.walletProvider = walletProviderOrKey
    } else {
      this.zilliqa = new Zilliqa(this.rpcEndpoint)
    }
    console.log('SDK ----- INITIALIZE ----- 2')

    // HEX CONTRACT DETAILS
    this.contractAddress = HEX[network]
    this.contract = (this.walletProvider || this.zilliqa).contracts.at(this.contractAddress)
    this.contractHash = fromBech32Address(this.contractAddress).toLowerCase()

    // HASH CONTRACT DETAILS
    this.hashContractAddress = HASH[network]
    this.hashContract = (this.walletProvider || this.zilliqa).contracts.at(this.hashContractAddress)
    this.hashContractHash = fromBech32Address(this.hashContractAddress).toLowerCase()

    // HUSD CONTRACT DETAILS
    this.husdContractAddress = HUSD[network]
    this.husdContract = (this.walletProvider || this.zilliqa).contracts.at(this.husdContractAddress)
    this.husdContractHash = fromBech32Address(this.husdContractAddress).toLowerCase()

    // HEX CONTRACT DETAILS
    this.dexContractAddress = DEX[network]
    this.dexContract = (this.walletProvider || this.zilliqa).contracts.at(this.dexContractAddress)
    this.dexContractHash = fromBech32Address(this.dexContractAddress).toLowerCase()

    // LAUNCHER CONTRACT ADDRESS
    this.launcherContractAddress = LAUNCHER[network]
    this.launcherContract = (this.walletProvider || this.zilliqa).contracts.at(this.launcherContractAddress)
    this.launcherContractHash = fromBech32Address(this.launcherContractAddress).toLowerCase()

    // REGUSTER CONTRACT ADDERSS
    this.registerContractAddress = REGISTER[network]
    this.registerContract = (this.walletProvider || this.zilliqa).contracts.at(this.registerContractAddress)
    this.registerContractHash = fromBech32Address(this.registerContractAddress).toLowerCase()

    this.tokens = {}
    this.zilos = {}
    this._txParams.version = CHAIN_VERSIONS[network]
    console.log('SDK ----- INITIALIZE ----- 3')

    if (options) {
      if (options.deadlineBuffer && options.deadlineBuffer > 0) this.deadlineBuffer = options.deadlineBuffer
      if (options.gasPrice && options.gasPrice > 0) this._txParams.gasPrice = toPositiveQa(options.gasPrice, units.Units.Li)
      if (options.gasLimit && options.gasLimit > 0) this._txParams.gasLimit = Long.fromNumber(options.gasLimit)
    }

    this.observerMutex = new Mutex()
  }

  /**
   * Intializes the SDK, fetching a cache of the Zilswap contract state and
   * subscribing to subsequent state changes. You may optionally pass an array
   * of ObservedTx's to subscribe to status changes on any of those txs.
   *
   * @param subscription is the callback function to call when a tx state changes.
   * @param observedTx is the array of txs to observe.
   */
  public async initialize(subscription?: OnUpdate, observeTxs: ObservedTx[] = []) {
    console.log('SDK ----- INITIALIZE ----- 4')
    console.log('test11111111')
    console.log(this)
    console.log('test1111111')
    this.observedTxs = observeTxs
    if (subscription) this.observer = subscription
    if (this._txParams.gasPrice.isZero()) {
      const minGasPrice = await this.zilliqa.blockchain.getMinimumGasPrice()
      if (!minGasPrice.result) throw new Error('Failed to get min gas price.')
      this._txParams.gasPrice = new BN(minGasPrice.result)
    }
    this.subscribeToAppChanges()
    await this.loadTokenList()
    await this.updateBlockHeight()
    console.log('SDK ----- APP STATE ---- 0')
    await this.updateAppState()
    await this.updateBalanceAndNonce()
    console.log('test22222222')
    console.log(this)
    console.log('test22222222')
  }

  /**
   * Initializes a new Zilo instance and registers it to the ZilSwap SDK,
   * subscribing to subsequent state changes in the Zilo instance. You may
   * optionally pass a state observer to subscribe to state changes of this
   * particular Zilo instance.
   *
   * If the Zilo instance is already registered, no new instance will be
   * created. If a new state observer is provided, it will overwrite the
   * existing one.
   *
   * @param address is the Zilo contract address which can be given by
   * either hash (0x...) or bech32 address (zil...).
   * @param onStateUpdate is the state observer which triggers when state
   * updates
   */
  public async registerZilo(address: string, onStateUpdate?: OnStateUpdate): Promise<Zilo> {
    console.log('test33333333333')
    const byStr20Address = this.parseRecipientAddress(address)

    if (this.zilos[byStr20Address]) {
      this.zilos[byStr20Address].updateObserver(onStateUpdate)
      return this.zilos[byStr20Address]
    }

    const zilo = new Zilo(this, byStr20Address)
    await zilo.initialize(onStateUpdate)
    this.zilos[byStr20Address] = zilo

    this.subscribeToAppChanges()

    return zilo
  }

  /**
   * Deregisters an existing Zilo instance. Does nothing if provided
   * address is not already registered.
   *
   * @param address is the Zilo contract address which can be given by
   * either hash (0x...) or bech32 address (zil...).
   */
  public deregisterZilo(address: string) {
    console.log('test44444444444444')
    const byStr20Address = this.parseRecipientAddress(address)

    if (!this.zilos[byStr20Address]) {
      return
    }

    delete this.zilos[address]

    this.subscribeToAppChanges()
  }

  /**
   * Stops watching the Zilswap contract state.
   */
  public async teardown() {
    this.subscription?.stop()

    const stopped = new Promise<void>(resolve => {
      const checkSubscription = () => {
        if (this.subscription) {
          setTimeout(checkSubscription, 100)
        } else {
          resolve()
        }
      }
      checkSubscription()
    })
    await stopped
  }

  /**
   * Gets the latest Zilswap app state.
   */
  public getAppState(): AppState {
    console.log('SDK ----- APP STATE ---- 1')
    console.log(this)
    console.log('SDK ----- APP STATE ---- 2')
    if (!this.appState) {
      throw new Error('App state not loaded, call #initialize first.')
    }

    console.log('SDK ----- APP STATE ---- 3')
    console.log(this)
    console.log('SDK ----- APP STATE ---- 4')
    return this.appState
  }

  /**
   * Gets the latest UPDATED Zilswap app state.
   */
  public async getUpdatedAppState(): Promise<AppState> {
    console.log('SDK ----- NWEWE APP STATE ---- 1')
    console.log(this)
    console.log('SDK ----- NWEWE APP STATE ---- 2')
    if (!this.appState) {
      throw new Error('App state not loaded, call #initialize first.')
    } else {
      // To update Balances in the Web App (Added on 10AUG2021)
      await this.updateAppState()
    }
    console.log('SDK ----- NWEWE APP STATE ---- 3')
    console.log(this)
    console.log('SDK ----- NWEWE APP STATE ---- 4')
    return this.appState
  }

  /**
   * Gets the contract with the given address that can be called by the default account.
   */
  public getContract(address: string): Contract {
    return (this.walletProvider || this.zilliqa).contracts.at(address)
  }

  /**
   * Gets the pool details for the given `tokenID`.
   *
   * @param tokenID is the token ID for the pool, which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...).
   * @returns {Pool} if pool exists, or `null` otherwise.
   */
  public getPool(tokenID: string): Pool | null {
    if (!this.appState) {
      throw new Error('App state not loaded, call #initialize first.')
    }
    return this.appState.pools[this.getTokenAddresses(tokenID).hash] || null
  }

  /**
   * Gets the currently observed transactions.
   */
  public async getObservedTxs(): Promise<ObservedTx[]> {
    const release = await this.observerMutex.acquire()
    try {
      return [...this.observedTxs]
    } finally {
      release()
    }
  }

  /**
   * Converts an amount to it's unitless representation (integer, no decimals) from it's
   * human representation (with decimals based on token contract, or 12 decimals for ZIL).
   * @param tokenID is the token ID related to the conversion amount, which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...). The hash for ZIL is represented by the HUSD_HASH constant.
   * @param amountHuman is the amount as a human string (e.g. 4.2 for 4.2 ZILs) to be converted.
   */
  public toUnitless(tokenID: string, amountHuman: string): string {
    const token = this.getTokenDetails(tokenID)
    const amountUnitless = new BigNumber(amountHuman).shiftedBy(token.decimals)
    if (!amountUnitless.integerValue().isEqualTo(amountUnitless)) {
      throw new Error(`Amount ${amountHuman} for ${token.symbol} has too many decimals, max is ${token.decimals}.`)
    }
    return amountUnitless.toString()
  }

  /**
   * Converts an amount to it's human representation (with decimals based on token contract, or 12 decimals for ZIL)
   * from it's unitless representation (integer, no decimals).
   * @param tokenID is the token ID related to the conversion amount, which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...). The hash for ZIL is represented by the HUSD_HASH constant.
   * @param amountStr is the unitless amount as a string (e.g. 42000000000000 for 42 ZILs) to be converted.
   */
  public toUnit(tokenID: string, amountStr: string): string {
    const token = this.getTokenDetails(tokenID)
    const amountBN = new BigNumber(amountStr)
    if (!amountBN.integerValue().isEqualTo(amountStr)) {
      throw new Error(`Amount ${amountStr} for ${token.symbol} cannot have decimals.`)
    }
    return amountBN.shiftedBy(-token.decimals).toString()
  }

  /**
   * Gets the expected output amount and slippage for a particular set of ZRC-2 or ZIL tokens at the given input amount.
   *
   * @param tokenInID is the token ID to be sent to Zilswap (sold), which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...). The hash for ZIL is represented by the HUSD_HASH constant.
   * @param tokenOutID is the token ID to be taken from Zilswap (bought), which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...). The hash for ZIL is represented by the HUSD_HASH constant.
   * @param tokenInAmountStr is the exact amount of tokens to be sent to Zilswap as a unitless representable string (without decimals).
   */
  public getRatesForInput(tokenInID: string, tokenOutID: string, tokenInAmountStr: string): Rates {
    console.log('TESTT SKKKKKKKKKKK -------------- ENTRYYYYYYY')
    const tokenIn = this.getTokenDetails(tokenInID)
    const tokenOut = this.getTokenDetails(tokenOutID)
    const tokenInAmount = unitlessBigNumber(tokenInAmountStr)
    console.log('INSIDE SDK GET RATES START 1111111')
    console.log(tokenIn, tokenOut, tokenInAmount)
    const { epsilonOutput, expectedOutput } = this.getOutputs(tokenIn, tokenOut, tokenInAmount)

    return {
      expectedAmount: expectedOutput,
      slippage: epsilonOutput.minus(expectedOutput).times(100).dividedBy(epsilonOutput).minus(0.3),
    }
  }

  /**
   * Gets the expected input amount and slippage for a particular set of ZRC-2 or ZIL tokens at the given output amount.
   * Returns NaN values if the given output amount is larger than the pool reserve.
   *
   * @param tokenInID is the token ID to be sent to Zilswap (sold), which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...). The hash for ZIL is represented by the HUSD_HASH constant.
   * @param tokenOutID is the token ID to be taken from Zilswap (bought), which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...). The hash for ZIL is represented by the HUSD_HASH constant.
   * @param tokenOutAmountStr is the exact amount of tokens to be received from Zilswap as a unitless representable string (without decimals).
   */
  public getRatesForOutput(tokenInID: string, tokenOutID: string, tokenOutAmountStr: string): Rates {
    const tokenIn = this.getTokenDetails(tokenInID)
    const tokenOut = this.getTokenDetails(tokenOutID)
    const tokenOutAmount = unitlessBigNumber(tokenOutAmountStr)
    console.log('INSIDE SDK GET RATES START 1111111')
    console.log(tokenIn, tokenOut, tokenOutAmount)
    const { epsilonInput, expectedInput } = this.getInputs(tokenIn, tokenOut, tokenOutAmount)

    return {
      expectedAmount: expectedInput,
      slippage: expectedInput.minus(epsilonInput).times(100).dividedBy(expectedInput).minus(0.3),
    }
  }

  /**
   * Sets the number of blocks to use as the allowable buffer duration before transactions
   * are considered invalid.
   *
   * When a transaction is signed, the deadline block by adding the buffer blocks to
   * the latest confirmed block height.
   *
   * @param bufferBlocks is the number of blocks to use as buffer for the deadline block.
   */
  public setDeadlineBlocks(bufferBlocks: number) {
    if (bufferBlocks <= 0) {
      throw new Error('Buffer blocks must be greater than 0.')
    }
    this.deadlineBuffer = bufferBlocks
  }

  /**
   * Observes the given transaction until the deadline block.
   *
   * Calls the `OnUpdate` callback given during `initialize` with the updated ObservedTx
   * when a change has been observed.
   *
   * @param observedTx is the txn hash of the txn to observe with the deadline block number.
   */
  public async observeTx(observedTx: ObservedTx) {
    const release = await this.observerMutex.acquire()
    try {
      this.observedTxs.push(observedTx)
    } finally {
      release()
    }
  }

  /**
   * Adds a token which is not already loaded by the default tokens file to the SDK.
   * @param tokenAddress is the token address in base16 (0x...) or bech32 (zil...) form.
   *
   * @returns true if the token could be found, or false otherwise.
   */
  public async addToken(tokenAddress: string): Promise<boolean> {
    if (!this.appState) {
      throw new Error('App state not loaded, call #initialize first.')
    }
    try {
      const details = await this.fetchTokenDetails(tokenAddress)
      this.appState!.tokens[details.hash] = details
      return true
    } catch {
      return false
    }
  }

  /**
   * Approves allowing the Zilswap contract to transfer ZRC-2 token with `tokenID`, if the current
   * approved allowance is less than `amount`. If the allowance is sufficient, this method is a no-op.
   *
   * The approval is done by calling `IncreaseAllowance` with the allowance amount as the entire
   * token supply. This is done so that the approval needs to only be done once per token contract,
   * reducing the number of approval transactions required for users conducting multiple swaps.
   *
   * Non-custodial control of the token is ensured by the Zilswap contract itself, which does not
   * allow for the transfer of tokens unless explicitly invoked by the sender.
   *
   * The transaction is added to the list of observedTxs, and the observer will be notified on
   * a confirmation or rejection event. The transation will be assumed to be expired after the default
   * deadline buffer, even though there is no deadline block for this transaction.
   *
   * @param tokenID is the token ID for the pool, which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...).
   * @param amountStrOrBN is the required allowance amount the Zilswap contract requires, below which the
   * `IncreaseAllowance` transition is invoked, as a unitless string or BigNumber.
   * @param spenderHash (optional) is the spender contract address, defaults to the ZilSwap contract address.
   *
   * @returns an ObservedTx if IncreaseAllowance was called, null if not.
   */
  public async approveTokenTransferToHexIfRequired(
    tokenID: string,
    amountStrOrBN: BigNumber | string,
    spenderHash: string = this.contractHash
  ): Promise<ObservedTx | null> {
    // Check logged in
    this.checkAppLoadedWithUser()

    // const spenderHash = this.contractHash
    const _spenderHash = this.parseRecipientAddress(spenderHash)
    const token = this.getTokenDetails(tokenID)
    const tokenState = await token.contract.getSubState('allowances', [this.appState!.currentUser!, _spenderHash])
    const allowance = new BigNumber(tokenState?.allowances[this.appState!.currentUser!]?.[_spenderHash] || 0)
    const amount: BigNumber = typeof amountStrOrBN === 'string' ? unitlessBigNumber(amountStrOrBN) : amountStrOrBN

    if (allowance.lt(amount)) {
      try {
        console.log('sending increase allowance txn..')
        const approveTxn = await this.callContract(
          token.contract,
          'IncreaseAllowance',
          [
            {
              vname: 'spender',
              type: 'ByStr20',
              value: _spenderHash,
            },
            {
              vname: 'amount',
              type: 'Uint128',
              value: amount.minus(allowance).toString(),
            },
          ],
          {
            amount: new BN(0),
            ...this.txParams(),
          },
          true
        )

        const observeTxn = {
          hash: approveTxn.id!,
          deadline: this.deadlineBlock(),
        }
        await this.observeTx(observeTxn)

        return observeTxn
      } catch (err) {
        if (err.message === 'Could not get balance') {
          throw new Error('No ZIL to pay for transaction.')
        } else {
          throw err
        }
      }
    }

    return null
  }

  /**
   * Adds liquidity to the pool with the given `tokenID`. The given `zilsToAddHuman` represents the exact quantity of ZIL
   * that will be contributed, while the given `tokensToAddHuman` represents the target quantity of ZRC-2 tokens to be
   * contributed.
   *
   * To ensure the liquidity contributor does not lose value to arbitrage, the target token amount should be strictly
   * derived from the current exchange rate that can be found using {@linkcode getPool}.
   *
   * The maximum fluctuation in exchange rate from the given parameters can be controlled through `maxExchangeRateChange`,
   * to protect against changes in pool reserves between the txn submission and txn confirmation on the Zilliqa blockchain.
   *
   * If the pool has no liquidity yet, the token amount given will be the exact quantity of tokens that will be contributed,
   * and the `maxExchangeRateChange` is ignored.
   *
   * The transaction is added to the list of observedTxs, and the observer will be notified on change in tx status.
   *
   * Note that all amounts should be given with decimals in it's human represented form, rather than as a unitless integer.
   *
   * @param tokenID is the token ID for the pool, which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...).
   * @param zilsToAddStr is the exact amount of zilliqas to contribute to the pool in ZILs as a unitless string.
   * @param tokensToAddStr is the target amount of tokens to contribute to the pool as a unitless string.
   * @param maxExchangeRateChange is the maximum allowed exchange rate flucuation
   * given in {@link https://www.investopedia.com/terms/b/basispoint.asp basis points}. Defaults to 200 = 2.00% if not provided.
   */
  public async AddSponsor(tokenID: string, husdToAddStr: string): Promise<ObservedTx> {
    // Check logged in
    this.checkAppLoadedWithUser()

    // Format token amounts
    const token = this.getTokenDetails(tokenID)
    const husd = this.getTokenDetails(HUSD_HASH)
    const husdToAdd = new BigNumber(husdToAddStr)

    // Calculate allowances
    const pool = this.getPool(token.hash)
    const zilAmount = new BN(0)

    // Check HUSD balances
    await this.checkAllowedBalance(husd, husdToAdd, this.launcherContractHash)

    // Set Deadline
    const deadline = this.deadlineBlock()

    // Sending Transaction
    console.log('sending add liquidity txn..')
    const addSponsorTxn = await this.callContract(
      this.launcherContract,
      'AddSponser',
      [
        {
          vname: 'token',
          type: 'ByStr20',
          value: token.hash,
        },
        {
          vname: 'husd_amount',
          type: 'Uint128',
          value: husdToAdd.toString(),
        },
        {
          vname: 'deadline_block',
          type: 'BNum',
          value: deadline.toString(),
        },
      ],
      {
        amount: zilAmount, // _amount
        ...this.txParams(),
      },
      true
    )

    if (addSponsorTxn.isRejected()) {
      throw new Error('Submitted transaction was rejected.')
    }

    const observeTxn = {
      hash: addSponsorTxn.id!,
      deadline,
    }
    await this.observeTx(observeTxn)

    return observeTxn
  }

  /**
   * Adds liquidity to the pool with the given `tokenID`. The given `zilsToAddHuman` represents the exact quantity of ZIL
   * that will be contributed, while the given `tokensToAddHuman` represents the target quantity of ZRC-2 tokens to be
   * contributed.
   *
   * To ensure the liquidity contributor does not lose value to arbitrage, the target token amount should be strictly
   * derived from the current exchange rate that can be found using {@linkcode getPool}.
   *
   * The maximum fluctuation in exchange rate from the given parameters can be controlled through `maxExchangeRateChange`,
   * to protect against changes in pool reserves between the txn submission and txn confirmation on the Zilliqa blockchain.
   *
   * If the pool has no liquidity yet, the token amount given will be the exact quantity of tokens that will be contributed,
   * and the `maxExchangeRateChange` is ignored.
   *
   * The transaction is added to the list of observedTxs, and the observer will be notified on change in tx status.
   *
   * Note that all amounts should be given with decimals in it's human represented form, rather than as a unitless integer.
   *
   * @param tokenID is the token ID for the pool, which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...).
   * @param zilsToAddStr is the exact amount of zilliqas to contribute to the pool in ZILs as a unitless string.
   * @param tokensToAddStr is the target amount of tokens to contribute to the pool as a unitless string.
   * @param maxExchangeRateChange is the maximum allowed exchange rate flucuation
   * given in {@link https://www.investopedia.com/terms/b/basispoint.asp basis points}. Defaults to 200 = 2.00% if not provided.
   */
  public async addLiquidity(
    tokenID: string,
    husdToAddStr: string,
    tokensToAddStr: string,
    maxExchangeRateChange: number = 200
  ): Promise<ObservedTx> {
    // Check logged in
    this.checkAppLoadedWithUser()

    // Format token amounts
    const token = this.getTokenDetails(tokenID)
    const husd = this.getTokenDetails(HUSD_HASH)
    const tokensToAdd = new BigNumber(tokensToAddStr)
    const husdToAdd = new BigNumber(husdToAddStr)

    // Calculate allowances
    const pool = this.getPool(token.hash)
    const maxTokens = pool ? tokensToAdd.times(BASIS + maxExchangeRateChange).dividedToIntegerBy(BASIS) : tokensToAdd
    let minContribution = new BN(0)
    if (pool) {
      // sqrt(delta) * x = max allowed change in zil reserve
      // min contribution = zil added / max zil reserve * current total contributions
      const { zilReserve } = pool
      this.validateMaxExchangeRateChange(maxExchangeRateChange)
      const totalContribution = pool.totalContribution
      const numerator = totalContribution.times(husdToAdd.toString())
      const denominator = new BigNumber(BASIS).plus(maxExchangeRateChange).sqrt().times(zilReserve.toString())
      minContribution = new BN(numerator.dividedToIntegerBy(denominator).toString())
    }

    // Check balances
    await this.checkAllowedBalance(token, tokensToAdd)
    await this.checkAllowedBalance(husd, husdToAdd)

    const deadline = this.deadlineBlock()

    console.log('sending add liquidity txn..')
    const addLiquidityTxn = await this.callContract(
      this.contract,
      'AddLiquidity',
      [
        {
          vname: 'token_address',
          type: 'ByStr20',
          value: token.hash,
        },
        {
          vname: 'min_contribution_amount',
          type: 'Uint128',
          value: minContribution.toString(),
        },
        {
          vname: 'husd_amount',
          type: 'Uint128',
          value: husdToAdd.toString(),
        },
        {
          vname: 'max_token_amount',
          type: 'Uint128',
          value: maxTokens.toString(),
        },
        {
          vname: 'deadline_block',
          type: 'BNum',
          value: deadline.toString(),
        },
      ],
      {
        amount: new BN(0), // _amount
        ...this.txParams(),
      },
      true
    )

    if (addLiquidityTxn.isRejected()) {
      throw new Error('Submitted transaction was rejected.')
    }

    const observeTxn = {
      hash: addLiquidityTxn.id!,
      deadline,
    }
    await this.observeTx(observeTxn)

    return observeTxn
  }

  /**
   * Removes `contributionAmount` worth of liquidity from the pool with the given `tokenID`.
   *
   * The current user's contribution can be fetched in {@linkcode getPool}, and the expected returned amounts at the
   * current prevailing exchange rates can be calculated by prorating the liquidity pool reserves by the fraction of
   * the user's current contribution against the pool's total contribution.
   *
   * The maximum fluctuation in exchange rate from the given parameters can be controlled through `maxExchangeRateChange`,
   * to protect against changes in pool reserves between the txn submission and txn confirmation on the Zilliqa blockchain.
   *
   * The transaction is added to the list of observedTxs, and the observer will be notified on change in tx status.
   *
   * @param tokenID is the token ID for the pool, which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...).
   * @param contributionAmount is the exact amount of zilliqas to contribute to the pool in ZILs as a string.
   * @param maxExchangeRateChange is the maximum allowed exchange rate flucuation
   * given in {@link https://www.investopedia.com/terms/b/basispoint.asp basis points}. Defaults to 200 = 2.00% if not provided.
   */
  public async removeLiquidity(tokenID: string, contributionAmount: string, maxExchangeRateChange: number = 200): Promise<ObservedTx> {
    // Check logged in
    this.checkAppLoadedWithUser()

    // Check parameters
    this.validateMaxExchangeRateChange(maxExchangeRateChange)

    // Calculate contribution
    const token = this.getTokenDetails(tokenID)
    const pool = this.getPool(token.hash)
    if (!pool) {
      throw new Error('Pool not found.')
    }

    const { zilReserve, tokenReserve, userContribution, contributionPercentage } = pool
    // expected = reserve * (contributionPercentage / 100) * (contributionAmount / userContribution)
    const expectedZilAmount = zilReserve.times(contributionPercentage).times(contributionAmount).dividedBy(userContribution.times(100))
    const expectedTokenAmount = tokenReserve.times(contributionPercentage).times(contributionAmount).dividedBy(userContribution.times(100))
    const minZilAmount = expectedZilAmount.times(BASIS).dividedToIntegerBy(BASIS + maxExchangeRateChange)
    const minTokenAmount = expectedTokenAmount.times(BASIS).dividedToIntegerBy(BASIS + maxExchangeRateChange)

    // Check contribution
    if (userContribution.lt(contributionAmount)) {
      throw new Error('Trying to remove more contribution than available.')
    }

    const deadline = this.deadlineBlock()

    console.log('sending remove liquidity txn..')
    const removeLiquidityTxn = await this.callContract(
      this.contract,
      'RemoveLiquidity',
      [
        {
          vname: 'token_address',
          type: 'ByStr20',
          value: token.hash,
        },
        {
          vname: 'contribution_amount',
          type: 'Uint128',
          value: contributionAmount,
        },
        {
          vname: 'min_zil_amount',
          type: 'Uint128',
          value: minZilAmount.toString(),
        },
        {
          vname: 'min_token_amount',
          type: 'Uint128',
          value: minTokenAmount.toString(),
        },
        {
          vname: 'deadline_block',
          type: 'BNum',
          value: deadline.toString(),
        },
      ],
      {
        amount: new BN(0),
        ...this.txParams(),
      },
      true
    )

    if (removeLiquidityTxn.isRejected()) {
      throw new Error('Submitted transaction was rejected.')
    }

    const observeTxn = {
      hash: removeLiquidityTxn.id!,
      deadline,
    }
    await this.observeTx(observeTxn)

    return observeTxn
  }

  /**
   * Swaps ZIL or a ZRC-2 token with `tokenInID` for a corresponding ZIL or ZRC-2 token with `tokenOutID`.
   *
   * The exact amount of ZIL or ZRC-2 to be sent in (sold) is `tokenInAmountHuman`. The amount received is determined by the prevailing
   * exchange rate at the current AppState. The expected amount to be received can be given fetched by getExpectedOutput (NYI).
   *
   * The maximum additional slippage incurred due to fluctuations in exchange rate from when the
   * transaction is signed and when it is processed by the Zilliqa blockchain can be bounded by the
   * `maxAdditionalSlippage` variable.
   *
   * The transaction is added to the list of observedTxs, and the observer will be notified on change in tx status.
   *
   * @param tokenInID is the token ID to be sent to Zilswap (sold), which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...). The hash for ZIL is represented by the HUSD_HASH constant.
   * @param tokenOutID is the token ID to be taken from Zilswap (bought), which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...). The hash for ZIL is represented by the HUSD_HASH constant.
   * @param tokenInAmountStr is the exact amount of tokens to be sent to Zilswap as a unitless string (without decimals).
   * @param maxAdditionalSlippage is the maximum additional slippage (on top of slippage due to constant product formula) that the
   * transition will allow before reverting.
   * @param recipientAddress is an optional recipient address for receiving the output of the swap in base16 (0x...) or bech32 (zil...).
   * Defaults to the sender address if `null` or undefined.
   */
  public async swapHashHusd(
    tokenInID: string,
    tokenOutID: string,
    tokenInAmountStr: string,
    maxAdditionalSlippage: number = 200,
    recipientAddress: string | null = null
  ): Promise<ObservedTx> {
    this.checkAppLoadedWithUser()

    const tokenIn = this.getTokenDetails(tokenInID)
    const tokenOut = this.getTokenDetails(tokenOutID)
    const tokenInAmount = unitlessBigNumber(tokenInAmountStr)
    // const { expectedOutput } = this.getOutputs(tokenIn, tokenOut, tokenInAmount)
    // const minimumOutput = expectedOutput.times(BASIS).dividedToIntegerBy(BASIS + maxAdditionalSlippage)
    const parsedRecipientAddress = this.parseRecipientAddress(recipientAddress)

    // await this.checkAllowedBalance(tokenIn, tokenInAmount)

    const deadline = this.deadlineBlock()

    let txn: { smartContract: Contract; transition: string; args: Value[]; params: CallParams }

    if (tokenIn.hash === HUSD_HASH) {
      // zil to zrc2
      txn = {
        smartContract: this.husdContract,
        transition: 'ConvertHusdtoHash',
        args: [
          {
            vname: 'amount',
            type: 'Uint128',
            value: tokenInAmount.toString(),
          },
        ],
        params: {
          amount: new BN(0),
          ...this.txParams(),
        },
      }
    } else {
      // zrc2 to zil
      txn = {
        smartContract: this.hashContract,
        transition: 'ConvertHashtoHusd',
        args: [
          {
            vname: 'amount',
            type: 'Uint128',
            value: tokenInAmount.toString(),
          },
        ],
        params: {
          amount: new BN(0),
          ...this.txParams(),
        },
      }
    }

    console.log('sending swap txn..')
    const swapTxn = await this.callContract(txn.smartContract, txn.transition, txn.args, txn.params, true)

    if (swapTxn.isRejected()) {
      throw new Error('Submitted transaction was rejected.')
    }

    const observeTxn = {
      hash: swapTxn.id!,
      deadline,
    }
    await this.observeTx(observeTxn)

    return observeTxn
  }

  /**
   * Swaps ZIL or a ZRC-2 token with `tokenInID` for a corresponding ZIL or ZRC-2 token with `tokenOutID`.
   *
   * The exact amount of ZIL or ZRC-2 to be sent in (sold) is `tokenInAmountHuman`. The amount received is determined by the prevailing
   * exchange rate at the current AppState. The expected amount to be received can be given fetched by getExpectedOutput (NYI).
   *
   * The maximum additional slippage incurred due to fluctuations in exchange rate from when the
   * transaction is signed and when it is processed by the Zilliqa blockchain can be bounded by the
   * `maxAdditionalSlippage` variable.
   *
   * The transaction is added to the list of observedTxs, and the observer will be notified on change in tx status.
   *
   * @param tokenInID is the token ID to be sent to Zilswap (sold), which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...). The hash for ZIL is represented by the HUSD_HASH constant.
   * @param tokenOutID is the token ID to be taken from Zilswap (bought), which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...). The hash for ZIL is represented by the HUSD_HASH constant.
   * @param tokenInAmountStr is the exact amount of tokens to be sent to Zilswap as a unitless string (without decimals).
   * @param maxAdditionalSlippage is the maximum additional slippage (on top of slippage due to constant product formula) that the
   * transition will allow before reverting.
   * @param recipientAddress is an optional recipient address for receiving the output of the swap in base16 (0x...) or bech32 (zil...).
   * Defaults to the sender address if `null` or undefined.
   */
  public async swapWithExactInput(
    tokenInID: string,
    tokenOutID: string,
    tokenInAmountStr: string,
    maxAdditionalSlippage: number = 200,
    recipientAddress: string | null = null
  ): Promise<ObservedTx> {
    this.checkAppLoadedWithUser()

    const tokenIn = this.getTokenDetails(tokenInID)
    const tokenOut = this.getTokenDetails(tokenOutID)
    const tokenInAmount = unitlessBigNumber(tokenInAmountStr)
    const { expectedOutput } = this.getOutputs(tokenIn, tokenOut, tokenInAmount)

    const minimumOutput = expectedOutput.times(BASIS).dividedToIntegerBy(BASIS + maxAdditionalSlippage)
    const parsedRecipientAddress = this.parseRecipientAddress(recipientAddress)

    await this.checkAllowedBalance(tokenIn, tokenInAmount)

    const deadline = this.deadlineBlock()

    let txn: { transition: string; args: Value[]; params: CallParams }

    if (tokenIn.hash === HUSD_HASH) {
      // zil to zrc2
      txn = {
        transition: 'SwapExactHUSDForTokens',
        args: [
          {
            vname: 'token_address',
            type: 'ByStr20',
            value: tokenOut.hash,
          },
          {
            vname: 'husd_amount',
            type: 'Uint128',
            value: tokenInAmount.toString(),
          },
          {
            vname: 'min_token_amount',
            type: 'Uint128',
            value: minimumOutput.toString(),
          },
          {
            vname: 'deadline_block',
            type: 'BNum',
            value: deadline.toString(),
          },
          {
            vname: 'recipient_address',
            type: 'ByStr20',
            value: parsedRecipientAddress,
          },
        ],
        params: {
          amount: new BN(0),
          ...this.txParams(),
        },
      }
    } else if (tokenOut.hash === HUSD_HASH) {
      // zrc2 to zil
      txn = {
        transition: 'SwapExactTokensForHUSD',
        args: [
          {
            vname: 'token_address',
            type: 'ByStr20',
            value: tokenIn.hash,
          },
          {
            vname: 'token_amount',
            type: 'Uint128',
            value: tokenInAmount.toString(),
          },
          {
            vname: 'min_husd_amount',
            type: 'Uint128',
            value: minimumOutput.toString(),
          },
          {
            vname: 'deadline_block',
            type: 'BNum',
            value: deadline.toString(),
          },
          {
            vname: 'recipient_address',
            type: 'ByStr20',
            value: parsedRecipientAddress,
          },
        ],
        params: {
          amount: new BN(0),
          ...this.txParams(),
        },
      }
    } else {
      // zrc2 to zrc2
      txn = {
        transition: 'SwapExactTokensForTokens',
        args: [
          {
            vname: 'token0_address',
            type: 'ByStr20',
            value: tokenIn.hash,
          },
          {
            vname: 'token1_address',
            type: 'ByStr20',
            value: tokenOut.hash,
          },
          {
            vname: 'token0_amount',
            type: 'Uint128',
            value: tokenInAmount.toString(),
          },
          {
            vname: 'min_token1_amount',
            type: 'Uint128',
            value: minimumOutput.toString(),
          },
          {
            vname: 'deadline_block',
            type: 'BNum',
            value: deadline.toString(),
          },
          {
            vname: 'recipient_address',
            type: 'ByStr20',
            value: parsedRecipientAddress,
          },
        ],
        params: {
          amount: new BN(0),
          ...this.txParams(),
        },
      }
    }

    console.log('sending swap txn..')
    const swapTxn = await this.callContract(this.contract, txn.transition, txn.args, txn.params, true)

    if (swapTxn.isRejected()) {
      throw new Error('Submitted transaction was rejected.')
    }

    const observeTxn = {
      hash: swapTxn.id!,
      deadline,
    }
    await this.observeTx(observeTxn)

    return observeTxn
  }

  /**
   * Swaps ZIL or a ZRC-2 token with `tokenInID` for a corresponding ZIL or ZRC-2 token with `tokenOutID`.
   *
   * The exact amount of ZIL or ZRC-2 to be received (bought) is `tokenOutAmountHuman`. The amount sent is determined by the prevailing
   * exchange rate at the current AppState. The expected amount to be sent can be given fetched by getExpectedInput (NYI).
   *
   * The maximum additional slippage incurred due to fluctuations in exchange rate from when the
   * transaction is signed and when it is processed by the Zilliqa blockchain can be bounded by the
   * `maxAdditionalSlippage` variable.
   *
   * The transaction is added to the list of observedTxs, and the observer will be notified on change in tx status.
   *
   * @param tokenInID is the token ID to be sent to Zilswap (sold), which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...). The hash for ZIL is represented by the HUSD_HASH constant.
   * @param tokenOutID is the token ID to be taken from Zilswap (bought), which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...). The hash for ZIL is represented by the HUSD_HASH constant.
   * @param tokenOutAmountStr is the exact amount of tokens to be received from Zilswap as a unitless string (withoout decimals).
   * @param maxAdditionalSlippage is the maximum additional slippage (on top of slippage due to constant product formula) that the
   * transition will allow before reverting.
   * @param recipientAddress is an optional recipient address for receiving the output of the swap in base16 (0x...) or bech32 (zil...).
   * Defaults to the sender address if `null` or undefined.
   */
  public async swapWithExactOutput(
    tokenInID: string,
    tokenOutID: string,
    tokenOutAmountStr: string,
    maxAdditionalSlippage: number = 200,
    recipientAddress: string | null = null
  ): Promise<ObservedTx> {
    this.checkAppLoadedWithUser()

    const tokenIn = this.getTokenDetails(tokenInID)
    const tokenOut = this.getTokenDetails(tokenOutID)
    const tokenOutAmount = unitlessBigNumber(tokenOutAmountStr)
    const { expectedInput } = this.getInputs(tokenIn, tokenOut, tokenOutAmount)
    const maximumInput = expectedInput.times(BASIS + maxAdditionalSlippage).dividedToIntegerBy(BASIS)
    const parsedRecipientAddress = this.parseRecipientAddress(recipientAddress)

    await this.checkAllowedBalance(tokenIn, maximumInput)

    const deadline = this.deadlineBlock()

    let txn: { transition: string; args: Value[]; params: CallParams }

    if (tokenIn.hash === HUSD_HASH) {
      // zil to zrc2
      txn = {
        transition: 'SwapHUSDForExactTokens',
        args: [
          {
            vname: 'token_address',
            type: 'ByStr20',
            value: tokenOut.hash,
          },
          {
            vname: 'max_husd_amount',
            type: 'Uint128',
            value: maximumInput.toString(),
          },
          {
            vname: 'token_amount',
            type: 'Uint128',
            value: tokenOutAmount.toString(),
          },
          {
            vname: 'deadline_block',
            type: 'BNum',
            value: deadline.toString(),
          },
          {
            vname: 'recipient_address',
            type: 'ByStr20',
            value: parsedRecipientAddress,
          },
        ],
        params: {
          amount: new BN(0),
          ...this.txParams(),
        },
      }
    } else if (tokenOut.hash === HUSD_HASH) {
      // zrc2 to zil
      txn = {
        transition: 'SwapTokensForExactHUSD',
        args: [
          {
            vname: 'token_address',
            type: 'ByStr20',
            value: tokenIn.hash,
          },
          {
            vname: 'max_token_amount',
            type: 'Uint128',
            value: maximumInput.toString(),
          },
          {
            vname: 'husd_amount',
            type: 'Uint128',
            value: tokenOutAmount.toString(),
          },
          {
            vname: 'deadline_block',
            type: 'BNum',
            value: deadline.toString(),
          },
          {
            vname: 'recipient_address',
            type: 'ByStr20',
            value: parsedRecipientAddress,
          },
        ],
        params: {
          amount: new BN(0),
          ...this.txParams(),
        },
      }
    } else {
      // zrc2 to zrc2
      txn = {
        transition: 'SwapTokensForExactTokens',
        args: [
          {
            vname: 'token0_address',
            type: 'ByStr20',
            value: tokenIn.hash,
          },
          {
            vname: 'token1_address',
            type: 'ByStr20',
            value: tokenOut.hash,
          },
          {
            vname: 'max_token0_amount',
            type: 'Uint128',
            value: maximumInput.toString(),
          },
          {
            vname: 'token1_amount',
            type: 'Uint128',
            value: tokenOutAmount.toString(),
          },
          {
            vname: 'deadline_block',
            type: 'BNum',
            value: deadline.toString(),
          },
          {
            vname: 'recipient_address',
            type: 'ByStr20',
            value: parsedRecipientAddress,
          },
        ],
        params: {
          amount: new BN(0),
          ...this.txParams(),
        },
      }
    }

    console.log('sending swap txn..')
    const swapTxn = await this.callContract(this.contract, txn.transition, txn.args, txn.params, true)

    if (swapTxn.isRejected()) {
      throw new Error('Submitted transaction was rejected.')
    }

    const observeTxn = {
      hash: swapTxn.id!,
      deadline,
    }
    await this.observeTx(observeTxn)

    return observeTxn
  }

  private getInputs(
    tokenIn: TokenDetails,
    tokenOut: TokenDetails,
    tokenOutAmount: BigNumber
  ): { epsilonInput: BigNumber; expectedInput: BigNumber } {
    let expectedInput: BigNumber // the expected amount after slippage and fees
    let epsilonInput: BigNumber // the zero slippage input

    if (tokenIn.hash === HUSD_HASH) {
      // zil to zrc2
      const { zilReserve, tokenReserve } = this.getReserves(tokenOut)
      epsilonInput = tokenOutAmount.times(zilReserve).dividedToIntegerBy(tokenReserve)
      expectedInput = this.getInputFor(tokenOutAmount, zilReserve, tokenReserve)
    } else if (tokenOut.hash === HUSD_HASH) {
      // zrc2 to zil
      const { zilReserve, tokenReserve } = this.getReserves(tokenIn)
      epsilonInput = tokenOutAmount.times(tokenReserve).dividedToIntegerBy(zilReserve)
      expectedInput = this.getInputFor(tokenOutAmount, tokenReserve, zilReserve)
    } else {
      // zrc2 to zrc2
      const { zilReserve: zr1, tokenReserve: tr1 } = this.getReserves(tokenOut)
      const intermediateEpsilonInput = tokenOutAmount.times(zr1).dividedToIntegerBy(tr1)
      const intermediateInput = this.getInputFor(tokenOutAmount, zr1, tr1)

      const { zilReserve: zr2, tokenReserve: tr2 } = this.getReserves(tokenIn)
      epsilonInput = intermediateEpsilonInput.times(tr2).dividedToIntegerBy(zr2)
      expectedInput = this.getInputFor(intermediateInput, tr2, zr2)
    }

    return { epsilonInput, expectedInput }
  }

  private getOutputs(
    tokenIn: TokenDetails,
    tokenOut: TokenDetails,
    tokenInAmount: BigNumber
  ): { epsilonOutput: BigNumber; expectedOutput: BigNumber } {
    let epsilonOutput: BigNumber // the zero slippage output
    let expectedOutput: BigNumber // the expected amount after slippage and fees

    console.log('SDK ----- INSIDE GET OUTOUT ----- 11111')

    if (tokenIn.hash === HUSD_HASH) {
      // zil to zrc2
      console.log('SDK ----- INSIDE GET OUTOUT ----- 222222')
      const { zilReserve, tokenReserve } = this.getReserves(tokenOut)
      console.log('ZILRESERVE', zilReserve)
      console.log('TOKENRESERVE', tokenReserve)
      epsilonOutput = tokenInAmount.times(tokenReserve).dividedToIntegerBy(zilReserve)
      expectedOutput = this.getOutputFor(tokenInAmount, zilReserve, tokenReserve)
    } else if (tokenOut.hash === HUSD_HASH) {
      // zrc2 to zil
      console.log('SDK ----- INSIDE GET OUTOUT ----- 333333')
      const { zilReserve, tokenReserve } = this.getReserves(tokenIn)
      epsilonOutput = tokenInAmount.times(zilReserve).dividedToIntegerBy(tokenReserve)
      expectedOutput = this.getOutputFor(tokenInAmount, tokenReserve, zilReserve)
      console.log('EXTRA INFO')
      console.log('EXTRA INFO')
      console.log(zilReserve, tokenReserve)
      console.log(epsilonOutput)
      console.log(expectedOutput)
      console.log('EXTRA INFO')
      console.log('EXTRA INFO')
    } else {
      // zrc2 to zrc2
      console.log('SDK ----- INSIDE GET OUTOUT ----- 444444')
      const { zilReserve: zr1, tokenReserve: tr1 } = this.getReserves(tokenIn)
      const intermediateEpsilonOutput = tokenInAmount.times(zr1).dividedToIntegerBy(tr1)
      const intermediateOutput = this.getOutputFor(tokenInAmount, tr1, zr1)

      const { zilReserve: zr2, tokenReserve: tr2 } = this.getReserves(tokenOut)
      epsilonOutput = intermediateEpsilonOutput.times(tr2).dividedToIntegerBy(zr2)
      expectedOutput = this.getOutputFor(intermediateOutput, zr2, tr2)
    }
    console.log('SDK ----- INSIDE GET OUTOUT ----- 55555511111')

    console.log(epsilonOutput, expectedOutput)

    return { epsilonOutput, expectedOutput }
  }

  private getInputFor(outputAmount: BigNumber, inputReserve: BigNumber, outputReserve: BigNumber): BigNumber {
    if (inputReserve.isZero() || outputReserve.isZero()) {
      throw new Error('Reserve has 0 tokens.')
    }
    if (outputReserve.lte(outputAmount)) {
      return new BigNumber('NaN')
    }
    const numerator = inputReserve.times(outputAmount).times(10000)
    const denominator = outputReserve.minus(outputAmount).times(this.getAfterFeeBps())
    return numerator.dividedToIntegerBy(denominator).plus(1)
  }

  private getOutputFor(inputAmount: BigNumber, inputReserve: BigNumber, outputReserve: BigNumber): BigNumber {
    console.log('SDK ----- INSIDE FORRRRR GET OUTOUT ----- 11111')
    if (inputReserve.isZero() || outputReserve.isZero()) {
      throw new Error('Reserve has 0 tokens.')
    }

    const testAfterFee = this.getAfterFeeBps()
    const bnTestAfterFee = new BigNumber(testAfterFee)

    console.log(testAfterFee)
    console.log(bnTestAfterFee)
    console.log(inputAmount)

    console.log('GET AFTER FEEES', this.getAfterFeeBps)

    const inputAfterFee = inputAmount.times(this.getAfterFeeBps())
    console.log('INPUT AFTER FEES', inputAfterFee)

    const numerator = inputAfterFee.times(outputReserve)
    console.log('NUMERATOR', numerator)
    const denominator = inputReserve.times(10000).plus(inputAfterFee)
    console.log('DENOMINATOR', denominator)
    console.log('ANSWER', numerator.dividedToIntegerBy(denominator))
    return numerator.dividedToIntegerBy(denominator)
    console.log('SDK ----- INSIDE FORRRRRR GET OUTOUT ----- 11111')
  }

  private getAfterFeeBps(): string {
    return this.getAppState().contractState.output_after_fee
  }

  private getReserves(token: TokenDetails) {
    const pool = this.getPool(token.hash)

    if (!pool) {
      return {
        zilReserve: new BigNumber(0),
        tokenReserve: new BigNumber(0),
      }
    }

    const { zilReserve, tokenReserve } = pool
    return { zilReserve, tokenReserve }
  }

  public async callContract(
    contract: Contract,
    transition: string,
    args: Value[],
    params: CallParams,
    toDs?: boolean
  ): Promise<Transaction> {
    if (this.walletProvider) {
      // ugly hack for zilpay provider
      const txn = await (contract as any).call(transition, args, params, toDs)
      txn.id = txn.ID
      txn.isRejected = function (this: { errors: any[]; exceptions: any[] }) {
        return this.errors.length > 0 || this.exceptions.length > 0
      }
      return txn
    } else {
      return await contract.callWithoutConfirm(transition, args, params, toDs)
    }
  }

  private subscribeToAppChanges() {
    // clear existing subscription, if any
    this.subscription?.stop()

    const ziloContractHashes = Object.keys(this.zilos)
    const subscription = this.zilliqa.subscriptionBuilder.buildEventLogSubscriptions(WSS[this.network], {
      addresses: [this.contractHash, this.launcherContractHash, this.registerContractHash, ...ziloContractHashes],
    })

    subscription.subscribe({ query: MessageType.NEW_BLOCK })

    subscription.emitter.on(StatusType.SUBSCRIBE_EVENT_LOG, event => {
      console.log('ws connected: ', event)
    })

    subscription.emitter.on(MessageType.NEW_BLOCK, event => {
      // console.log('ws new block: ', JSON.stringify(event, null, 2))
      this.updateBlockHeight().then(() => this.updateObservedTxs())
    })

    subscription.emitter.on(MessageType.EVENT_LOG, event => {
      if (!event.value) return
      // console.log('ws update: ', JSON.stringify(event, null, 2))
      this.updateAppState()
    })

    subscription.emitter.on(MessageType.EVENT_LOG, event => {
      if (!event.value) return
      // console.log('ws update: ', JSON.stringify(event, null, 2))
      this.updateAppState()

      // update zilo states

      const ziloAddresses = Object.keys(this.zilos)
      if (!ziloAddresses.length) return

      // loop through events to find updates in registered zilos
      for (const item of event.value) {
        const byStr20Address = `0x${item.address}`
        const index = ziloAddresses.indexOf(byStr20Address)
        if (index >= 0) {
          this.zilos[byStr20Address].updateZiloState()

          // remove updated zilo contract from list
          ziloAddresses.splice(index, 1)
        }
      }
    })

    subscription.emitter.on(MessageType.UNSUBSCRIBE, event => {
      console.log('ws disconnected: ', event)
      this.subscription = null
    })

    subscription.start()

    this.subscription = subscription
  }

  private async loadTokenList() {
    if (this.network === Network.TestNet) {
      this.tokens['ZIL'] = 'zil1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq9yf6pz'
      this.tokens['ZWAP'] = 'zil1k2c3ncjfduj9jrhlgx03t2smd6p25ur56cfzgz'
      this.tokens['gZIL'] = 'zil1fytuayks6njpze00ukasq3m4y4s44k79hvz8q5'
      this.tokens['SWTH'] = 'zil1d6yfgycu9ythxy037hkt3phc3jf7h6rfzuft0s'
      this.tokens['XSGD'] = 'zil10a9z324aunx2qj64984vke93gjdnzlnl5exygv'
      this.tokens['ZLP'] = 'zil1du93l0dpn8wy40769raza23fjkvm868j9rjehn'
      this.tokens['PORT'] = 'zil10v5nstu2ff9jsm7074wer6s6xtklh9xga7n8xc'
      this.tokens['REDC'] = 'zil14jmjrkvfcz2uvj3y69kl6gas34ecuf2j5ggmye'
      this.tokens['STREAM'] = 'zil10w9gdtaau3d5uzqescshuqn9fd23gpa82myjqc'
      this.tokens['zDAI'] = 'zil1nnga67uer2vk0harvu345vz7vl3v0pta6vr3sf'
      this.tokens['zETH'] = 'zil1j53x0y8myrcpy6u4n42qe0yuxn5t2ttedah8jp'
      return
    }

    const res = await fetch('https://api.zilstream.com/tokens')
    const tokens = await res.json()

    interface ZilStreamToken {
      symbol: string
      address_bech32: string
    }

    tokens.forEach((token: ZilStreamToken) => (this.tokens[token.symbol] = token.address_bech32))
  }

  private async updateBlockHeight(): Promise<void> {
    const response = await this.zilliqa.blockchain.getNumTxBlocks()
    const bNum = parseInt(response.result!, 10)
    this.currentBlock = bNum

    for (const ziloAddress of Object.keys(this.zilos)) {
      // updateBlockHeight should only trigger update if
      // contract state will be changed, i.e. only when
      // currentBlock === zilo init.start_block or init.end_block.
      await this.zilos[ziloAddress].updateBlockHeight(bNum)
    }
  }

  private readOptionalState(optString: string, argString: string[]): BigNumber {
    if (optString === 'Some') {
      return new BigNumber(argString[0])
    }

    return new BigNumber(0)
  }

  private readLaunchState(stateString: string): LaunchState {
    const constructorHash = this.launcherContractHash
    const validationString = constructorHash + '.' + 'Validation'
    const openString = constructorHash + '.' + 'Open'
    const toLaunchString = constructorHash + '.' + 'ToLaunch'
    const launchedString = constructorHash + '.' + 'Launched'
    const onHoldString = constructorHash + '.' + 'OnHold'
    const dissolveString = constructorHash + '.' + 'Dissolve'

    if (stateString === validationString) {
      return LaunchState.Validation
    }
    if (stateString === openString) {
      return LaunchState.Open
    }
    if (stateString === toLaunchString) {
      return LaunchState.ToLaunch
    }
    if (stateString === launchedString) {
      return LaunchState.Launched
    }
    if (stateString === onHoldString) {
      return LaunchState.OnHold
    }
    if (stateString === dissolveString) {
      return LaunchState.Dissolve
    }
    return LaunchState.Undefined
  }

  private async updateAppState(): Promise<void> {
    // Get user address
    console.log('SDK ----- UPDATE APP STATE ---- 1')
    const currentUser = this.walletProvider
      ? // ugly hack for zilpay provider
        this.walletProvider.wallet.defaultAccount.base16.toLowerCase()
      : this.zilliqa.wallet.defaultAccount?.address?.toLowerCase() || null

    console.log('SDK ----- UPDATE APP STATE ---- 2')
    // Get the contract state for HEX
    const requests: BatchRequest[] = []
    const address = this.contractHash.replace('0x', '')
    const launcherAddress = this.launcherContractHash.replace('0x', '')

    requests.push({ id: '1', method: 'GetSmartContractSubState', params: [address, 'output_after_fee', []], jsonrpc: '2.0' })
    requests.push({ id: '2', method: 'GetSmartContractSubState', params: [address, 'pools', []], jsonrpc: '2.0' })
    requests.push({ id: '3', method: 'GetSmartContractSubState', params: [address, 'total_contributions', []], jsonrpc: '2.0' })

    requests.push({ id: '4', method: 'GetSmartContractSubState', params: [launcherAddress, 'launchs', []], jsonrpc: '2.0' })
    requests.push({ id: '5', method: 'GetSmartContractSubState', params: [launcherAddress, 'total_sponsorship', []], jsonrpc: '2.0' })
    requests.push({ id: '6', method: 'GetSmartContractSubState', params: [launcherAddress, 'influencer', []], jsonrpc: '2.0' })

    const result = await sendBatchRequest(this.rpcEndpoint, requests)
    const contractState = Object.values(result).reduce((a, i) => ({ ...a, ...i }), {
      balances: {},
      sponsors: {},
      zero_sponsor: {},
    }) as ContractState

    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')
    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')
    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')
    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')
    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')
    console.log(contractState)
    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')
    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')
    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')
    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')
    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')
    console.log('NEW FUNCTION STARTING')

    // Get Pool state for HASH
    const requests5: BatchRequest[] = []
    const dexAddress = this.dexContractHash.replace('0x', '')
    requests5.push({
      id: '1',
      method: 'GetSmartContractSubState',
      params: [dexAddress, 'pools', [HASH_HASH]],
      jsonrpc: '2.0',
    })
    const result5 = await sendBatchRequest(this.rpcEndpoint, requests5)
    console.log(dexAddress)
    console.log(result5)

    const valResult5 = Object.values(result)

    Object.values(result5).forEach((res: BatchResponse) => {
      Object.values(res).forEach((pool: BatchResponse) => {
        Object.entries(pool).forEach(([token, mapOrNull]) => {
          contractState.pools[token] = mapOrNull ? mapOrNull : {}
        })

        console.log('TESTIN INSIDEEEE ----------- +++++++++')
        console.log('TESTIN INSIDEEEE ----------- +++++++++')
        console.log('TESTIN INSIDEEEE ----------- +++++++++')
        console.log('TESTIN INSIDEEEE ----------- +++++++++')
        console.log('TESTIN INSIDEEEE ----------- +++++++++')
        console.log(pool)
        console.log('TESTIN INSIDEEEE ----------- +++++++++')
        console.log('TESTIN INSIDEEEE ----------- +++++++++')
        console.log('TESTIN INSIDEEEE ----------- +++++++++')
        console.log('TESTIN INSIDEEEE ----------- +++++++++')
        console.log('TESTIN INSIDEEEE ----------- +++++++++')
        /*
    ([token, mapOrNull]) => {
    
      console.log("INSIDEDEEE TESTTTT LOOOP")
      console.log(token)
      console.log(mapOrNull)
      console.log("INSIDEDEEE TESTTTT LOOOP")
      contractState.pools[token] = mapOrNull ? mapOrNull.pools[token] : {}
    })
  */
      })
    })
    console.log('NEW FUNCTION ENDINGGG')
    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')
    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')
    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')
    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')
    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')
    console.log(contractState)
    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')
    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')
    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')
    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')
    console.log('++++++-------++++++-------+++++++---------++++++++++---------++++++++')

    // Get Balances from HEX
    if (currentUser) {
      const requests2: BatchRequest[] = []
      Object.keys(contractState.pools).forEach(token => {
        requests2.push({
          id: token,
          method: 'GetSmartContractSubState',
          params: [address, 'balances', [token, currentUser]],
          jsonrpc: '2.0',
        })
      })
      const result2 = await sendBatchRequest(this.rpcEndpoint, requests2)
      Object.entries(result2).forEach(([token, mapOrNull]) => {
        contractState.balances[token] = mapOrNull ? mapOrNull.balances[token] : {}
      })
    }

    // Get the launcher contract state - SPONSORS(Balances)
    if (currentUser) {
      const requests3: BatchRequest[] = []
      Object.keys(contractState.launchs).forEach(token => {
        requests3.push({
          id: token,
          method: 'GetSmartContractSubState',
          params: [launcherAddress, 'sponsors', [token, currentUser]],
          jsonrpc: '2.0',
        })
      })
      const result3 = await sendBatchRequest(this.rpcEndpoint, requests3)
      console.log('55555555555555555555')
      console.log('55555555555555555555')
      console.log('55555555555555555555')
      console.dir(result3, { depth: null })
      console.log(result3)
      console.log('55555555555555555555')
      console.log('55555555555555555555')
      console.log('55555555555555555555')
      Object.entries(result3).forEach(([token, mapOrNull]) => {
        contractState.sponsors[token] = mapOrNull ? mapOrNull.sponsors[token] : {}
      })
    }

    // Get the launcher contract state - ZERO SPONSORS(Balances)
    if (currentUser) {
      const requests4: BatchRequest[] = []
      Object.keys(contractState.launchs).forEach(token => {
        requests4.push({
          id: token,
          method: 'GetSmartContractSubState',
          params: [launcherAddress, 'sponsors', [token, ZERO_HASH]],
          jsonrpc: '2.0',
        })
      })
      const result4 = await sendBatchRequest(this.rpcEndpoint, requests4)
      console.log('55555555555555555555')
      console.log('55555555555555555555')
      console.log('55555555555555555555')
      console.dir(result4, { depth: null })
      console.log(result4)
      console.log('55555555555555555555')
      console.log('55555555555555555555')
      console.log('55555555555555555555')
      Object.entries(result4).forEach(([token, mapOrNull]) => {
        contractState.zero_sponsor[token] = mapOrNull ? mapOrNull.sponsors[token] : {}
      })
    }

    // Get id of tokens that have sponsor pools
    let poolTokenHashes = Object.keys(contractState.pools)
    poolTokenHashes = poolTokenHashes.concat(Object.keys(contractState.launchs))
    poolTokenHashes = poolTokenHashes.concat(HUSD_HASH)
    // poolTokenHashes = poolTokenHashes.concat(HASH_HASH)

    console.log('SDK ----- UPDATE APP STATE ---- 7')
    // Get id of tokens that have liquidity pools
    // const poolTokenHashes = Object.keys(contractState.pools)
    const defaultTokenHashes = Object.values(this.tokens).map((bech32: string) => this.getTokenAddresses(bech32).hash)
    const tokenHashes = poolTokenHashes.concat(defaultTokenHashes.filter((item: string) => poolTokenHashes.indexOf(item) < 0))

    // Get token details
    const tokens: { [key in string]: TokenDetails } = {}
    const promises = tokenHashes.map(async hash => {
      const d = await this.fetchTokenDetails(hash)
      tokens[hash] = d
    })
    await Promise.all(promises)

    // Get Sponsortoken
    const sponsors: { [key in string]: SponsorToken } = {}
    poolTokenHashes.forEach(tokenHash => {
      if (!contractState.sponsors[tokenHash]) return

      const poolSponsors = contractState.sponsors[tokenHash]
      const userSponserToken = poolSponsors![currentUser!]
      console.log('888888888888888888888')
      console.log('888888888888888888888')
      console.log(tokenHash)
      console.dir(userSponserToken!, { depth: null })
      console.log(userSponserToken!)
      console.log('888888888888888888888')
      console.log('888888888888888888888')

      let sponsorHusd = new BigNumber(0)
      let removeHusd = new BigNumber(0)
      let transactionFee = new BigNumber(0)
      let entryBlock = new BigNumber(0)
      let lockIn = new BigNumber(0)

      if (userSponserToken !== undefined) {
        const [sp, rp, tp, fb, l] = userSponserToken!.arguments
        sponsorHusd = new BigNumber(sp)
        removeHusd = new BigNumber(rp)
        transactionFee = new BigNumber(tp)
        entryBlock = this.readOptionalState(fb.constructor.toString(), fb.arguments)
        lockIn = this.readOptionalState(l.constructor.toString(), l.arguments)
      }

      sponsors[tokenHash] = {
        sponsorHusd,
        removeHusd,
        transactionFee,
        entryBlock,
        lockIn,
      }
    })

    // Get zeroSponsortoken
    const zerosponsor: { [key in string]: SponsorToken } = {}
    poolTokenHashes.forEach(tokenHash => {
      if (!contractState.zero_sponsor[tokenHash]) return

      const poolZeroSponsors = contractState.zero_sponsor[tokenHash]
      const zeroSponserToken = poolZeroSponsors![ZERO_HASH]
      console.log('888888888888888888888')
      console.log('888888888888888888888')
      console.log(tokenHash)
      console.dir(zeroSponserToken!, { depth: null })
      console.log('888888888888888888888')
      console.log('888888888888888888888')

      let sponsorHusd = new BigNumber(0)
      let removeHusd = new BigNumber(0)
      let transactionFee = new BigNumber(0)
      let entryBlock = new BigNumber(0)
      let lockIn = new BigNumber(0)

      if (zeroSponserToken !== undefined) {
        const [sp, rp, tp, fb, l] = zeroSponserToken!.arguments
        sponsorHusd = new BigNumber(sp)
        removeHusd = new BigNumber(rp)
        transactionFee = new BigNumber(tp)
        entryBlock = this.readOptionalState(fb.constructor.toString(), fb.arguments)
        lockIn = this.readOptionalState(l.constructor.toString(), l.arguments)
      }

      zerosponsor[tokenHash] = {
        sponsorHusd,
        removeHusd,
        transactionFee,
        entryBlock,
        lockIn,
      }
    })

    // Get pool details for HASH token
    const pools: { [key in string]: Pool } = {}
    poolTokenHashes.forEach(tokenHash => {
      if (tokenHash !== HASH_HASH) return

      const hashSponsorship = bigZero
      const tokenSponsorship = bigZero
      const targetRate = bigZero
      const deadline = bigZero
      const state = this.readLaunchState('')
      const sponsorHusd = new BigNumber(0)
      const removeHusd = new BigNumber(0)
      const transactionFee = new BigNumber(0)
      const entryBlock = new BigNumber(0)
      const lockIn = new BigNumber(0)
      const sponsorToken: SponsorToken = {
        sponsorHusd,
        removeHusd,
        transactionFee,
        entryBlock,
        lockIn,
      }
      const userSponsor = sponsorToken
      const zeroSponsor = sponsorToken
      const totalSponsor = new BigNumber(0)

      const [x, y] = contractState.pools[tokenHash]!.arguments
      const zilReserve = new BigNumber(x)
      const tokenReserve = new BigNumber(y)
      const exchangeRate = zilReserve.dividedBy(tokenReserve)
      const totalContribution = new BigNumber(contractState.total_contributions[tokenHash]!)
      const poolBalances = contractState.balances[tokenHash]
      const userContribution = new BigNumber(0)
      const userEntryBlock = new BigNumber(0)
      const contributionPercentage = new BigNumber(0)

      pools[tokenHash] = {
        hashSponsorship,
        tokenSponsorship,
        targetRate,
        deadline,
        state,
        userSponsor,
        zeroSponsor,
        totalSponsor,

        zilReserve,
        tokenReserve,
        exchangeRate,
        totalContribution,
        userContribution,
        userEntryBlock,
        contributionPercentage,
      }
    })

    // Get pool details for all other tokens
    poolTokenHashes.forEach(tokenHash => {
      if (!contractState.launchs[tokenHash]) return

      const [x, y, p, s, d] = contractState.launchs[tokenHash]!.arguments
      const hashSponsorship = new BigNumber(x)
      const tokenSponsorship = new BigNumber(y)
      const targetRate = new BigNumber(p)
      const deadline = new BigNumber(d)
      const state = this.readLaunchState(s.constructor.toString())
      const userSponsor = sponsors[tokenHash]
      const zeroSponsor = zerosponsor[tokenHash]
      const totalSponsor = new BigNumber(contractState.total_sponsorship[tokenHash]!)

      let zilReserve = new BigNumber(0)
      let tokenReserve = new BigNumber(0)
      let exchangeRate = new BigNumber(0)
      let totalContribution = new BigNumber(0)
      let userContribution = new BigNumber(0)
      let userEntryBlock = new BigNumber(0)
      let contributionPercentage = new BigNumber(0)

      if (contractState.pools[tokenHash]) {
        const [z, t] = contractState.pools[tokenHash]!.arguments
        zilReserve = new BigNumber(z)
        tokenReserve = new BigNumber(t)
        exchangeRate = zilReserve.dividedBy(tokenReserve)
        totalContribution = new BigNumber(contractState.total_contributions[tokenHash]!)
        const poolBalances = contractState.balances[tokenHash]
        if (poolBalances !== undefined && currentUser) {
          const userPoolBalances = poolBalances![currentUser!]
          if (userPoolBalances !== undefined) {
            const [lp, eb] = userPoolBalances!.arguments
            userContribution = new BigNumber(lp)
            userEntryBlock = new BigNumber(eb)
          }
        }
        contributionPercentage = userContribution.dividedBy(totalContribution).times(100)
      }

      pools[tokenHash] = {
        hashSponsorship,
        tokenSponsorship,
        targetRate,
        deadline,
        state,
        userSponsor,
        zeroSponsor,
        totalSponsor,

        zilReserve,
        tokenReserve,
        exchangeRate,
        totalContribution,
        userContribution,
        userEntryBlock,
        contributionPercentage,
      }
    })

    // Set new state
    this.appState = {
      contractState,
      tokens,
      pools,
      currentUser,
      currentNonce: this.appState?.currentNonce || null,
      currentBalance: this.appState?.currentBalance || null,
    }
  }

  private async updateBalanceAndNonce() {
    if (this.appState?.currentUser) {
      try {
        const res: RPCBalanceResponse = (await this.zilliqa.blockchain.getBalance(this.appState.currentUser)).result
        if (!res) {
          this.appState.currentBalance = new BigNumber(0)
          this.appState.currentNonce = 0
          return
        }
        this.appState.currentBalance = new BigNumber(res.balance)
        this.appState.currentNonce = parseInt(res.nonce, 10)
      } catch (err) {
        // ugly hack for zilpay non-standard API
        if (err.message === 'Account is not created') {
          this.appState.currentBalance = new BigNumber(0)
          this.appState.currentNonce = 0
        }
      }
    }
  }

  private async updateObservedTxs() {
    const release = await this.observerMutex.acquire()
    try {
      const removeTxs: string[] = []
      const promises = this.observedTxs.map(async (observedTx: ObservedTx) => {
        try {
          const result = await this.zilliqa.blockchain.getTransactionStatus(observedTx.hash)

          if (result && result.modificationState === 2) {
            // either confirmed or rejected
            const confirmedTxn = await this.zilliqa.blockchain.getTransaction(observedTx.hash)
            const receipt = confirmedTxn.getReceipt()
            const txStatus = confirmedTxn.isRejected() ? 'rejected' : receipt?.success ? 'confirmed' : 'rejected'
            if (this.observer) this.observer(observedTx, txStatus, receipt)
            removeTxs.push(observedTx.hash)
            return
          }
        } catch (e) {
          if (e.code === -20) {
            // "Txn Hash not Present"
            console.warn(`tx not found in mempool: ${observedTx.hash}`)
          } else {
            console.warn('error fetching tx state')
            console.error(e)
          }
        }
        if (observedTx.deadline < this.currentBlock) {
          // expired
          console.log(`tx exceeded deadline: ${observedTx.deadline}, current: ${this.currentBlock}`)
          if (this.observer) this.observer(observedTx, 'expired')
          removeTxs.push(observedTx.hash)
        }
      })

      await Promise.all(promises)

      this.observedTxs = this.observedTxs.filter((tx: ObservedTx) => !removeTxs.includes(tx.hash))

      await this.updateBalanceAndNonce()
    } finally {
      release()
    }
  }

  private parseRecipientAddress(addr: string | null): string {
    const address: string = addr === null ? this.getAppState().currentUser! : addr
    if (address.substr(0, 2) === '0x') {
      return address.toLowerCase()
    } else if (address.length === 32) {
      return `0x${address}`.toLowerCase()
    } else if (address.substr(0, 3) === 'zil') {
      return fromBech32Address(address).toLowerCase()
    } else {
      throw new Error('Invalid recipient address format!')
    }
  }

  private getTokenAddresses(id: string): { hash: string; address: string } {
    let hash, address
    if (id.substr(0, 2) === '0x') {
      hash = id.toLowerCase()
      address = toBech32Address(hash)
    } else if (id.substr(0, 3) === 'zil' && id.length > 3) {
      address = id
      hash = fromBech32Address(address).toLowerCase()
    } else {
      address = this.tokens[id]
      hash = fromBech32Address(address).toLowerCase()
    }
    return { hash, address }
  }

  private getTokenDetails(id: string): TokenDetails {
    const { hash } = this.getTokenAddresses(id)
    if (!this.appState) {
      throw new Error('App state not loaded, call #initialize first.')
    }
    if (!this.appState.tokens[hash]) {
      throw new Error(`Could not find token details for ${id}`)
    }
    return this.appState.tokens[hash]
  }

  public async fetchContractInit(contract: Contract): Promise<any> {
    // try to use cache first
    const lsCacheKey = `contractInit:${contract.address!}`
    if (isLocalStorageAvailable()) {
      const result = localStorage.getItem(lsCacheKey)
      if (result && result !== '') {
        try {
          return JSON.parse(result)
        } catch (e) {
          console.error(e)
        }
      }
    }
    // motivation: workaround api.zilliqa.com intermittent connection issues.
    try {
      const init = await contract.getInit()
      if (isLocalStorageAvailable()) {
        localStorage.setItem(lsCacheKey, JSON.stringify(init))
      }
      return init
    } catch (error) {
      if (error?.message === 'Network request failed') {
        // make another fetch attempt after 800ms
        return this.fetchContractInit(contract)
      } else {
        throw error
      }
    }
  }

  private async fetchTokenDetails(id: string): Promise<TokenDetails> {
    console.log(id, '11111----------STARTTTTT')
    const { hash, address } = this.getTokenAddresses(id)

    if (!!this.appState?.tokens[hash]) return this.appState.tokens[hash]

    console.log(id, '333333311111----------STARTTTTT')
    const contract = this.getContract(address)

    console.log(id, '44444411111----------STARTTTTT')
    if (hash === ZIL_HASH) {
      console.log(id, '55555511111----------STARTTTTT')
      return { contract, address, hash, name: 'Zilliqa', symbol: 'ZIL', decimals: 12, whitelisted: true, registered: true }
      console.log(id, '66666611111----------STARTTTTT')
    }

    console.log(id, '777777711111----------STARTTTTT')
    const init = await this.fetchContractInit(contract)

    const decimalStr = init.find((e: Value) => e.vname === 'decimals').value as string
    const decimals = parseInt(decimalStr, 10)
    const name = init.find((e: Value) => e.vname === 'name').value as string
    const symbol = init.find((e: Value) => e.vname === 'symbol').value as string
    const registered = this.tokens[symbol] === address
    const whitelisted = registered && (symbol === 'ZWAP' || symbol === 'XSGD' || symbol === 'gZIL') // TODO: make an actual whitelist

    console.log(id, '222222----------STARTTTTT END')
    return { contract, address, hash, name, symbol, decimals, whitelisted, registered }
  }

  private async checkAllowedBalance(token: TokenDetails, amount: BigNumber, spenderHash: string = this.contractHash) {
    // Check init
    this.checkAppLoadedWithUser()
    const user = this.appState!.currentUser!

    if (token.hash === ZIL_HASH) {
      // Check zil balance
      const zilBalance = this.appState!.currentBalance!
      if (zilBalance.lt(amount)) {
        throw new Error(`Insufficent ZIL in wallet.
        Required: ${this.toUnit(token.hash, amount.toString()).toString()},
        have: ${this.toUnit(token.hash, zilBalance.toString()).toString()}.`)
      }
    } else {
      // Check zrc-2 balance
      const requests: BatchRequest[] = []
      const address = token.contract.address!.replace('0x', '')
      requests.push({ id: 'balances', method: 'GetSmartContractSubState', params: [address, 'balances', [user!]], jsonrpc: '2.0' })
      requests.push({
        id: 'allowances',
        method: 'GetSmartContractSubState',
        params: [address, 'allowances', [user!, spenderHash]],
        jsonrpc: '2.0',
      })
      const result = await sendBatchRequest(this.rpcEndpoint, requests)
      const balance = new BigNumber(result.balances?.balances[user] || 0)
      if (balance.lt(amount)) {
        throw new Error(`Insufficent tokens in wallet.
        Required: ${this.toUnit(token.hash, amount.toString()).toString()},
        have: ${this.toUnit(token.hash, balance.toString()).toString()}.`)
      }
      const allowance = new BigNumber(result.allowances?.allowances[user]?.[spenderHash] || 0)
      if (allowance.lt(amount)) {
        throw new Error(`Tokens need to be approved first.
        Required: ${this.toUnit(token.hash, amount.toString()).toString()},
        approved: ${this.toUnit(token.hash, allowance.toString()).toString()}.`)
      }
    }
  }

  public checkAppLoadedWithUser() {
    // Check init
    if (!this.appState) {
      throw new Error('App state not loaded, call #initialize first.')
    }

    // Check user address
    if (this.appState!.currentUser === null) {
      throw new Error('No wallet connected.')
    }

    // Check wallet account
    if (this.walletProvider && this.walletProvider.wallet.defaultAccount.base16.toLowerCase() !== this.appState!.currentUser) {
      throw new Error('Wallet user has changed, please reconnect.')
    }

    // Check network is correct
    if (this.walletProvider && this.walletProvider.wallet.net.toLowerCase() !== this.network.toLowerCase()) {
      throw new Error('Wallet is connected to wrong network.')
    }
  }

  public txParams(): TxParams & { nonce: number } {
    return {
      nonce: this.nonce(),
      ...this._txParams,
    }
  }

  public getCurrentBlock(): number {
    return this.currentBlock
  }

  public deadlineBlock(): number {
    return this.currentBlock + this.deadlineBuffer!
  }

  private nonce(): number {
    return this.appState!.currentNonce! + this.observedTxs.length + 1
  }

  private validateMaxExchangeRateChange(maxExchangeRateChange: number) {
    if (maxExchangeRateChange % 1 !== 0 || maxExchangeRateChange >= BASIS || maxExchangeRateChange < 0) {
      throw new Error(`MaxExchangeRateChange ${maxExchangeRateChange} must be an integer between 0 and ${BASIS + 1}.`)
    }
  }
}
