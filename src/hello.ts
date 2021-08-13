import 'isomorphic-fetch'
import { Zilliqa } from '@zilliqa-js/zilliqa'
import { Wallet, Transaction, TxReceipt as _TxReceipt } from '@zilliqa-js/account'
import { Contract, Value, CallParams } from '@zilliqa-js/contract'
import { fromBech32Address, toBech32Address } from '@zilliqa-js/crypto'
import { StatusType, MessageType, NewEventSubscription } from '@zilliqa-js/subscriptions'
import { BN, Long, units } from '@zilliqa-js/util'
import { BigNumber } from 'bignumber.js'
import { Mutex } from 'async-mutex'

import { APIS, WSS, CONTRACTS, DEX, HELLO, CHAIN_VERSIONS, BASIS, Network, ZIL_HASH } from './constants'
import { unitlessBigNumber, toPositiveQa, isLocalStorageAvailable } from './utils'
import { sendBatchRequest, BatchRequest } from './batch'

import { OnStateUpdate } from './zilo'

import { Options, OnUpdate, ObservedTx, TxStatus, TxReceipt, TxParams } from './index'

export type ContractState = {
  welcome_msg: string
}

export type AppState = {
  contractState: ContractState
  currentUser: string | null
  currentNonce: number | null
  currentBalance: BigNumber | null
}

export type Rates = {
  expectedAmount: BigNumber // in human amounts (with decimals)
  slippage: BigNumber // in percentage points
}

export type WalletProvider = Omit<
  Zilliqa & { wallet: Wallet & { net: string; defaultAccount: { base16: string; bech32: string } } }, // ugly hack for zilpay non-standard API
  'subscriptionBuilder'
>

type RPCBalanceResponse = { balance: string; nonce: string }

export class Hello {
  readonly zilliqa: Zilliqa

  /* Internals */
  private readonly rpcEndpoint: string
  private readonly walletProvider?: WalletProvider // zilpay
  private appState?: AppState // cached blockchain state for dApp and user

  /* Txn observers */
  private subscription: NewEventSubscription | null = null
  private observer: OnUpdate | null = null
  private observerMutex: Mutex
  private observedTxs: ObservedTx[] = []

  /* Deadline tracking */
  private deadlineBuffer: number = 3
  private currentBlock: number = -1

  /* Zilswap contract attributes */
  readonly contract: Contract
  readonly contractAddress: string
  readonly contractHash: string

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
    console.log('test1111')
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

    this.contractAddress = HELLO[network]
    this.contract = (this.walletProvider || this.zilliqa).contracts.at(this.contractAddress)
    this.contractHash = fromBech32Address(this.contractAddress).toLowerCase()
    this._txParams.version = CHAIN_VERSIONS[network]

    if (options) {
      if (options.deadlineBuffer && options.deadlineBuffer > 0) this.deadlineBuffer = options.deadlineBuffer
      if (options.gasPrice && options.gasPrice > 0) this._txParams.gasPrice = toPositiveQa(options.gasPrice, units.Units.Li)
      if (options.gasLimit && options.gasLimit > 0) this._txParams.gasLimit = Long.fromNumber(options.gasLimit)
    }

    this.observerMutex = new Mutex()
    console.log('test11111122222222')
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
    console.log('test22222222')
    console.log(this)
    console.log('test22222222')
    this.observedTxs = observeTxs
    if (subscription) this.observer = subscription
    if (this._txParams.gasPrice.isZero()) {
      const minGasPrice = await this.zilliqa.blockchain.getMinimumGasPrice()
      if (!minGasPrice.result) throw new Error('Failed to get min gas price.')
      this._txParams.gasPrice = new BN(minGasPrice.result)
    }
    this.subscribeToAppChanges()
    await this.updateBlockHeight()
    await this.updateAppState()
    await this.updateBalanceAndNonce()
    console.log('test22222222')
    console.log(this)
    console.log('test22222222')
  }

  /**
   * Gets the latest Zilswap app state.
   */
  public getAppState(): AppState {
    console.log('test6666666666666')
    if (!this.appState) {
      throw new Error('App state not loaded, call #initialize first.')
    }
    console.log(this.appState)
    return this.appState
  }

  private subscribeToAppChanges() {
    // clear existing subscription, if any
    this.subscription?.stop()

    const subscription = this.zilliqa.subscriptionBuilder.buildEventLogSubscriptions(WSS[this.network], {
      addresses: [this.contractHash],
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

    subscription.emitter.on(MessageType.UNSUBSCRIBE, event => {
      console.log('ws disconnected: ', event)
      this.subscription = null
    })

    subscription.start()

    this.subscription = subscription
  }

  public async observeTx(observedTx: ObservedTx) {
    const release = await this.observerMutex.acquire()
    try {
      this.observedTxs.push(observedTx)
    } finally {
      release()
    }
  }

  private async updateBlockHeight(): Promise<void> {
    const response = await this.zilliqa.blockchain.getNumTxBlocks()
    const bNum = parseInt(response.result!, 10)
    this.currentBlock = bNum
  }

  private async updateAppState(): Promise<void> {
    // Get user address
    const currentUser = this.walletProvider
      ? // ugly hack for zilpay provider
        this.walletProvider.wallet.defaultAccount.base16.toLowerCase()
      : this.zilliqa.wallet.defaultAccount?.address?.toLowerCase() || null

    // Get the contract state
    const requests: BatchRequest[] = []
    const address = this.contractHash.replace('0x', '')
    requests.push({ id: '1', method: 'GetSmartContractSubState', params: [address, 'welcome_msg', []], jsonrpc: '2.0' })
    const result = await sendBatchRequest(this.rpcEndpoint, requests)
    const contractState = Object.values(result).reduce((a, i) => ({ ...a, ...i }), { balances: {} }) as ContractState

    // Set new state
    this.appState = {
      contractState,
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

  /**
   * Stops watching the Zilswap contract state.
   */
  public async teardown() {
    console.log('test5555555555555')
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

  public async setHello(msg: string): Promise<ObservedTx> {
    // Check logged in
    this.checkAppLoadedWithUser()

    // Format token amounts
    const message = msg

    console.log('sending set hello txn..')
    const setHelloTxn = await this.callContract(
      this.contract,
      'setHello',
      [
        {
          vname: 'msg',
          type: 'String',
          value: message.toString(),
        },
      ],
      {
        amount: new BN(0),
        ...this.txParams(),
      },
      true
    )

    if (setHelloTxn.isRejected()) {
      throw new Error('Submitted transaction was rejected.')
    } else {
      console.log(setHelloTxn.id!)
    }

    const observeTxn = {
      hash: setHelloTxn.id!,
      deadline: this.deadlineBlock(),
    }
    await this.observeTx(observeTxn)

    return observeTxn
  }
}
