import WalletSelection from "./WalletSelection/WalletSelection";
import CreateWalletMachine from "./CreateWalletPage/CreateWalletPage";
import SettingUpWalletMachine from "./SetupWallet";
import Settings from "./Settings/Settings";
import Logs from "./Logs/Logs";
import { FormattedMessage as T } from "react-intl";
import { createElement as h } from "react";
import GetStartedMachinePage from "./GetStartedMachinePage";
import TrezorConfig from "./TrezorConfig/TrezorConfig";
import PreCreateWalletForm from "./PreCreateWallet/PreCreateWallet";
import RescanWalletBody from "./RescanWallet/RescanWallet";
import WalletPubpassInput from "./OpenWallet/OpenWallet";
import DiscoverAccounts from "./OpenWallet/DiscoverAccounts";
import ReleaseNotes from "./ReleaseNotes/ReleaseNotes";
import {
  OPENWALLET_INPUT,
  OPENWALLET_INPUTPRIVPASS
} from "actions/WalletLoaderActions";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useDaemonStartup } from "hooks";
import { useMachine } from "@xstate/react";
import { getStartedMachine } from "stateMachines/GetStartedStateMachine";
import { AdvancedStartupBody } from "./AdvancedStartup/AdvancedStartup";
import styles from "./GetStarted.module.css";
import { isObject } from "lodash";
import { wallet } from "wallet-preload-shim";

export const useGetStarted = () => {
  const {
    onRetryStartRPC,
    onGetAvailableWallets,
    onStartDaemon,
    setSelectedWallet,
    goToErrorPage,
    startSPVSync,
    isSPV,
    isAdvancedDaemon,
    getDaemonSynced,
    getSelectedWallet,
    syncFetchMissingCfiltersAttempt,
    syncFetchHeadersAttempt,
    syncRescanAttempt,
    syncDiscoverAddressesAttempt,
    synced,
    updateAvailable,
    isTestNet,
    checkNetworkMatch,
    onConnectDaemon,
    onStartWallet,
    syncDaemon,
    onOpenWallet,
    onShowTutorial,
    appVersion,
    syncAttemptRequest,
    onGetDcrdLogs,
    daemonWarning
  } = useDaemonStartup();
  const [PageComponent, setPageComponent] = useState(null);
  const [showNavLinks, setShowNavLinks] = useState(true);
  const [state, send] = useMachine(getStartedMachine, {
    actions: {
      isAtPreStart: () => {
        preStartDaemon();
      },
      isAtStartAdvancedDaemon: () => {},
      isAtLoadingConfig: () => {},
      isAtStartSPV: () => onSendContinue(),
      isAtStartingDaemon: (_, event) => {
        const { appdata } = event;
        return onStartDaemon({ appdata })
          .then((started) => {
            const { credentials, appdata } = started;
            send({
              type: "CONNECT_DAEMON",
              payload: { started, credentials, appdata }
            });
          })
          .catch((error) =>
            send({ type: "ERROR_STARTING_DAEMON", payload: { error } })
          );
      },
      isAtDaemonError: (context, event) => {
        if (!event) return;
        const {
          payload: { error }
        } = event;
        if (!error) return;
        const { isAdvancedDaemon } = context;
        // We send the user to the error page if decrediton is not in advanced mode.
        if (!isAdvancedDaemon) {
          // race because of react-router Redirect on /getStarted
          // this timeout solves it.
          return setTimeout(() => goToErrorPage(), 500);
        }
        send({ type: "START_ADVANCED_DAEMON", payload: { error } });
      },
      isAtConnectingDaemon: (_, event) => {
        const { remoteCredentials } = event;
        const daemonRemote = !!remoteCredentials;
        return onConnectDaemon(remoteCredentials, daemonRemote)
          .then(() => {
            send({ type: "SYNC_DAEMON" });
          })
          .catch((error) => {
            if (
              !error.connected &&
              error.error.includes &&
              error.error.includes("SSLV3_ALERT_HANDSHAKE_FAILURE")
            ) {
              error = (
                <T
                  id="getStarted.P_521_error"
                  m="Connection error. Probably you got this error because Decrediton no longer supports the P-521 curve. To fix it, you need to remove the rpc.cert and rpc.key and restart dcrd with the --tlscurve=P-256 param to allow it to generate a cert and key with that supported curve."
                />
              );
            }
            send({ type: "ERROR_CONNECTING_DAEMON", payload: { error } });
          });
      },
      isAtCheckNetworkMatch: () => {
        return checkNetworkMatch()
          .then(() => send({ type: "CHOOSE_WALLET" }))
          .catch((error) =>
            send({ type: "ERROR_NETWORK_DAEMON", payload: { error } })
          );
      },
      isAtSyncingDaemon: () => {
        syncDaemon()
          .then(() => send({ type: "CHECK_NETWORK_MATCH" }))
          .catch((error) =>
            send({ type: "ERROR_SYNCING_DAEMON", payload: { error } })
          );
      },
      isAtChoosingWallet: (ctx, event) => {
        const selectedWallet = event?.selectedWallet || ctx?.selectedWallet;
        const { availableWalletsError } = ctx;
        if (selectedWallet) {
          return submitChosenWallet(selectedWallet);
        }
        // if there is an availableWalletsError, we return as retrying
        // getting available wallets will probably cause an infinite loop.
        if (availableWalletsError) {
          return;
        }
        onGetAvailableWallets()
          .then((w) => send({ type: "CHOOSE_WALLET", payload: { w } }))
          .catch((error) => send({ type: "AVAILABLE_WALLET_ERROR", error }));

        setShowNavLinks(true);
      },
      isAtStartWallet: (context) => {
        const { selectedWallet } = context;
        const { passPhrase } = context;
        const { isWatchingOnly, isTrezor } = selectedWallet.value;
        const hasPassPhrase = !!passPhrase;
        onStartWallet(selectedWallet, hasPassPhrase)
          .then((discoverAccountsComplete) => {
            setSelectedWallet(selectedWallet);
            const { passPhrase } = context;
            if (
              !discoverAccountsComplete &&
              !passPhrase &&
              !isWatchingOnly &&
              !isTrezor
            ) {
              // Need to discover accounts and the passphrase isn't stored in
              // context, so ask for the private passphrase before continuing.
              send({ type: "WALLET_DISCOVERACCOUNTS_PASS" });
            } else {
              send({ type: "SYNC_RPC" });
            }
          })
          .catch((error) => {
            if (
              !selectedWallet.finished &&
              error.message.includes("missing database file")
            ) {
              return onShowCreateWallet({ isNew: error.walletCreatedAsNew });
            }

            // If the error is OPENWALLET_INPUTPRIVPASS, the wallet needs the
            // private passphrase to discover accounts and the user typed a wrong
            // one.
            if (error == OPENWALLET_INPUTPRIVPASS) {
              return send({ type: "WALLET_DISCOVERACCOUNTS_PASS" });
            }

            // If error is OPENWALLET_INPUT, the wallet has a pubpass and we
            // switch states, for inputing it and open the wallet.
            if (error === OPENWALLET_INPUT) {
              return send({ type: "WALLET_PUBPASS_INPUT" });
            }
            onSendError(error);
          });
      },
      isSyncingRPC: async (context) => {
        const { passPhrase, isSPV } = context;
        if (syncAttemptRequest) {
          return;
        }

        // if synced, it means that the wallet is finished to sync and we can
        // push decrediton to home view.
        if (synced === true) {
          send({ type: "SHOW_SETTING_UP_WALLET" });
        }
        if (isSPV) {
          return startSPVSync(passPhrase)
            .then(() => send({ type: "SHOW_SETTING_UP_WALLET" }))
            .catch((error) => {
              // If the error is OPENWALLET_INPUTPRIVPASS, the wallet needs the
              // private passphrase to discover accounts and the user typed a wrong
              // one.
              if (error == OPENWALLET_INPUTPRIVPASS) {
                send({ type: "WALLET_DISCOVERACCOUNTS_PASS" });
              }
              send({ type: "ERROR_SYNCING_WALLET", payload: { error } });
            });
        }
        try {
          try {
            await onRetryStartRPC(passPhrase);
          } catch (error) {
            if (error === OPENWALLET_INPUTPRIVPASS) {
              send({ type: "WALLET_DISCOVERACCOUNTS_PASS" });
              return;
            }
            throw error;
          }
          send({ type: "SHOW_SETTING_UP_WALLET" });
        } catch (error) {
          send({ type: "ERROR_SYNCING_WALLET", payload: { error } });
        }
      }
    }
  });
  const getError = useCallback((serviceError) => {
    if (!serviceError) return;

    // We can return errors in the form of react component, which are objects.
    // So we handle them first.
    if (React.isValidElement(serviceError)) {
      return serviceError;
    }

    // If the error is an instance of the Error class, extract the message.
    if (serviceError instanceof Error) {
      return serviceError.message;
    }

    // If the error is an object but not a react component, we stringify it so
    // we can render it.
    if (isObject(serviceError)) {
      return JSON.stringify(serviceError);
    }

    return serviceError;
  }, []);
  const error = useMemo(
    () => state && state.context && getError(state.context.error),
    [state, getError]
  );
  const availableWalletsError = useMemo(
    () =>
      state && state.context && getError(state.context.availableWalletsError),
    [state, getError]
  );

  // preStartDaemon gets data from cli to connect with remote dcrd if rpc
  // connection data is inputed and sends the first interaction with the state
  // machine, so it can start. Only one of the choises is chosen.
  const preStartDaemon = useCallback(() => {
    const cliOptions = wallet.getCLIOptions();
    let rpcCliRemote;
    if (cliOptions.rpcPresent) {
      rpcCliRemote = {
        rpc_user: cliOptions.rpcUser,
        rpc_pass: cliOptions.rpcPass,
        rpc_cert: cliOptions.rpcCert,
        rpc_host: cliOptions.rpcHost,
        rpc_port: cliOptions.rpcPort
      };
      send({
        type: "START_CLI_REMOTE_DAEMON",
        remoteCredentials: rpcCliRemote
      });
    }
    // If daemon is synced or isSPV mode we check for a selectedWallet.
    // If it is selected, it probably means a wallet was just pre created or
    // a refresh (common when in dev mode).
    if (getDaemonSynced || isSPV) {
      const selectedWallet = getSelectedWallet();
      // if the wallet is already selected,
      // no need to show the wallet selection screen
      if (selectedWallet) {
        return send({
          type: "SUBMIT_CHOOSE_WALLET",
          selectedWallet,
          isSPV,
          isAdvancedDaemon
        });
      } else {
        return send({
          type: "CHOOSE_WALLET",
          selectedWallet,
          isSPV,
          isAdvancedDaemon
        });
      }
    }
    send({ type: "START_SPV", isSPV });
    send({
      type: "START_ADVANCED_DAEMON",
      isSPV,
      isAdvancedDaemon
    });
    send({
      type: "START_REGULAR_DAEMON",
      isSPV,
      isAdvancedDaemon
    });
  }, [send, getDaemonSynced, getSelectedWallet, isAdvancedDaemon, isSPV]);

  const onSendContinue = useCallback(() => {
    send({ type: "CONTINUE" });
    setShowNavLinks(false);
  }, [send]);

  const onSendBack = useCallback(() => {
    send({ type: "BACK" });
    setShowNavLinks(true);
  }, [send]);

  const onSendError = useCallback((error) => send({ type: "ERROR", error }), [
    send
  ]);

  const onSendCreateWallet = useCallback(
    (isNew) => send({ type: "CREATE_WALLET", isNew }),
    [send]
  );

  const onSendSetPassphrase = useCallback(
    (passPhrase) => send({ type: "SETPASSPHRASE", passPhrase }),
    [send]
  );

  const onSendDiscoverAccountsPassInput = useCallback(
    () => send({ type: "WALLET_DISCOVERACCOUNTS_PASS" }),
    [send]
  );

  const onShowCreateWallet = useCallback(
    ({ isNew, walletMasterPubKey, isTrezor }) =>
      send({
        type: "SHOW_CREATE_WALLET",
        isNew,
        walletMasterPubKey,
        isTrezor
      }),
    [send]
  );

  const onShowReleaseNotes = useCallback(
    () => send({ type: "SHOW_RELEASE_NOTES" }),
    [send]
  );

  const submitChosenWallet = useCallback(
    ({ selectedWallet, error }) =>
      send({
        type: "SUBMIT_CHOOSE_WALLET",
        selectedWallet,
        error
      }),
    [send]
  );

  const submitRemoteCredentials = useCallback(
    (remoteCredentials) => send({ type: "SUBMIT_REMOTE", remoteCredentials }),
    [send]
  );

  const submitAppdata = useCallback(
    (appdata) => send({ type: "SUBMIT_APPDATA", appdata }),
    [send]
  );

  const onShowTrezorConfig = useCallback(
    () => send({ type: "SHOW_TREZOR_CONFIG" }),
    [send]
  );

  const getStateComponent = useCallback(
    (updatedText, updatedAnimationType, updatedComponent) => {
      const {
        isCreateNewWallet,
        isSPV,
        createWalletRef,
        settingUpWalletRef
      } = state.context;
      let component, text, animationType, PageComponent;

      const key = Object.keys(state.value)[0];
      if (key === "startMachine") {
        switch (state.value[key]) {
          case "startAdvancedDaemon":
            component = (
              <AdvancedStartupBody
                {...{
                  submitRemoteCredentials,
                  onStartDaemon: () => onSendContinue(),
                  submitAppdata
                }}
              />
            );
            text = (
              <T
                id="loaderBar.WaitingDaemon"
                m="Waiting for daemon connection..."
              />
            );
            break;
          case "connectingDaemon":
            text = (
              <T id="loaderBar.WaitingConnection" m="connecting to daemon..." />
            );
            break;
          case "checkingNetworkMatch":
            text = (
              <T
                id="loaderBar.checkingNetwork"
                m="Checking if network matches..."
              />
            );
            break;
          case "startingDaemon":
            animationType = styles.daemonWaiting;
            text = <T id="loaderBar.StartingDaemon" m="Starting Daemon..." />;
            break;
          case "syncingDaemon":
            animationType = styles.blockchainSyncing;
            text = <T id="loaderBar.syncingDaemon" m="Syncing Daemon..." />;
            break;
          case "choosingWallet":
            text = isSPV ? (
              <T
                id="loaderBar.choosingWalletSPV"
                m="Choose a wallet to open in SPV mode"
              />
            ) : (
              <T id="loaderBar.choosingWallet" m="Choose a wallet to open" />
            );
            component = h(WalletSelection, {
              onSendCreateWallet,
              submitChosenWallet,
              isSPV
            });
            break;
          case "preCreateWallet":
            text = isCreateNewWallet ? (
              <T id="loaderBar.preCreateWalletCreate" m="Create a wallet..." />
            ) : (
              <T
                id="loaderBar.preCreateWalletRestore"
                m="Restore a Wallet..."
              />
            );
            component = h(PreCreateWalletForm, {
              onShowCreateWallet,
              onSendContinue,
              onSendBack,
              onSendError,
              onShowTrezorConfig,
              isCreateNewWallet,
              error
            });
            break;
          case "walletPubpassInput":
            text = <T id="loaderBar.walletPubPass" m="Insert your pubkey" />;
            component = h(WalletPubpassInput, {
              onSendContinue,
              onSendError,
              onOpenWallet,
              error,
              onSendDiscoverAccountsPassInput
            });
            break;
          case "walletDiscoverAccountsPassInput":
            text = (
              <T
                id="loaderBar.walletDiscoverAccountsPass"
                m="Type passphrase to discover accounts"
              />
            );
            component = h(DiscoverAccounts, {
              onSendSetPassphrase,
              error
            });
            break;
          case "startingWallet":
            text = <T id="loaderBar.startingWallet" m="Starting wallet..." />;
            break;
          case "syncingRPC":
            animationType = styles.establishingRpc;
            text = (
              <T id="loaderBar.syncingRPC" m="Syncing RPC connection..." />
            );
            break;
        }
        PageComponent = h(GetStartedMachinePage, {
          submitRemoteCredentials,
          submitAppdata,
          error,
          availableWalletsError,
          isSPV,
          onShowReleaseNotes,
          onShowTutorial,
          appVersion,
          onGetDcrdLogs,
          daemonWarning,

          // if updated* is set, we use it, as it means it is called by the componentDidUpdate.
          text: updatedText ? updatedText : text,
          animationType: updatedAnimationType
            ? updatedAnimationType
            : animationType,
          StateComponent: updatedComponent ? updatedComponent : component
        });
      }
      if (key === "settings") {
        PageComponent = h(Settings, { onSendBack });
      }
      if (key === "logs") {
        PageComponent = h(Logs, { onSendBack });
      }
      if (key === "trezorConfig") {
        PageComponent = h(TrezorConfig, { onSendBack });
      }
      if (key === "releaseNotes") {
        PageComponent = h(ReleaseNotes, { onSendBack });
      }
      if (key === "creatingWallet") {
        PageComponent = h(CreateWalletMachine, {
          createWalletRef,
          isTestNet,
          onSendBack
        });
      }
      if (key === "settingUpWallet") {
        PageComponent = h(SettingUpWalletMachine, {
          settingUpWalletRef,
          appVersion,
          onShowTutorial,
          onShowReleaseNotes
        });
      }

      setPageComponent(PageComponent);
    },
    [
      state,
      isTestNet,
      onSendBack,
      onSendContinue,
      onShowTutorial,
      appVersion,
      onSendCreateWallet,
      onSendError,
      onShowCreateWallet,
      onShowReleaseNotes,
      onShowTrezorConfig,
      submitAppdata,
      submitChosenWallet,
      submitRemoteCredentials,
      onOpenWallet,
      onGetDcrdLogs,
      onSendDiscoverAccountsPassInput,
      onSendSetPassphrase,
      error,
      availableWalletsError,
      daemonWarning
    ]
  );

  const machineStateValue = state && state.value;
  useEffect(() => {
    let text, animationType, component;
    if (syncFetchMissingCfiltersAttempt) {
      animationType = styles.daemonWaiting;
      text = (
        <T
          id="getStarted.header.fetchingMissing.meta"
          m="Fetching missing committed filters"
        />
      );
    } else if (syncFetchHeadersAttempt) {
      animationType = styles.fetchingHeaders;
      text = (
        <T
          id="getStarted.header.fetchingBlockHeaders.meta"
          m="Fetching block headers"
        />
      );
    } else if (syncDiscoverAddressesAttempt) {
      animationType = styles.discoveringAddresses;
      text = (
        <T
          id="getStarted.header.discoveringAddresses.meta"
          m="Discovering addresses"
        />
      );
    } else if (syncRescanAttempt) {
      animationType = styles.scanningBlocks;
      text = (
        <T
          id="getStarted.header.rescanWallet.meta"
          m="Scanning blocks for transactions"
        />
      );
      component = RescanWalletBody;
    } else if (synced) {
      animationType = styles.finalizingSetup;
      text = (
        <T
          id="getStarted.header.finishingStart.meta"
          m="Finishing to load wallet"
        />
      );
    }
    getStateComponent(text, animationType, component);
  }, [
    syncFetchMissingCfiltersAttempt,
    syncFetchHeadersAttempt,
    syncDiscoverAddressesAttempt,
    syncRescanAttempt,
    synced,
    getStateComponent,
    machineStateValue
  ]);

  const onShowSettings = useCallback(() => send({ type: "SHOW_SETTINGS" }), [
    send
  ]);

  const onShowLogs = useCallback(() => send({ type: "SHOW_LOGS" }), [send]);

  return {
    onShowLogs,
    onShowSettings,
    updateAvailable,
    isTestNet,
    PageComponent,
    showNavLinks
  };
};
