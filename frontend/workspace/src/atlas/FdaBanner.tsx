import { useLanguage } from "@/context/language"
import { createSignal, createResource, type JSX, Show } from "solid-js"
import { Dialog } from "@synsci/ui/dialog"
import { useDialog } from "@synsci/ui/context/dialog"
import { IconRefresh, IconArrowRight } from "@/atlas/shared/Icon"
import { useGlobalSDK } from "@/context/global-sdk"
import { resolveServerRoute } from "@/config/server-url"
import "./FdaBanner.css"

interface ProbeResult {
  fda: boolean
  reason?: "permission_denied"
}

const DISMISS_KEY = "atlas.fda.banner.hidden"

async function probeFda(server: string): Promise<ProbeResult> {
  try {
    const res = await fetch(resolveServerRoute("/api/resolve-folder/probe", server, window.location.origin))
    if (!res.ok) return { fda: true }
    return await res.json()
  } catch {
    return { fda: true }
  }
}

function detectOS(): "mac" | "win" | "linux" {
  if (typeof navigator === "undefined") return "mac"
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes("mac")) return "mac"
  if (ua.includes("win")) return "win"
  return "linux"
}

const SETTINGS_URL: Record<"mac" | "win" | "linux", string | null> = {
  mac: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  win: null,
  linux: null,
}

const STEP_BODY = {
  mac: "pages.surface.macDenied",
  win: "pages.surface.winDenied",
  linux: "pages.surface.linuxDenied",
} as const

/**
 * Tiny status chip that surfaces only after an explicit protected-folder
 * permission denial. Lives next to the new-project button; click opens a
 * compact recovery sheet with a deliberate settings link and recheck.
 */
function FdaChip(): JSX.Element {
  const language = useLanguage()
  const sdk = useGlobalSDK()
  // Same reason as `dismiss`: reading the global is what throws when storage is
  // blocked, and `typeof` invokes the same getter, so it cannot guard the read.
  const stored = (() => {
    try {
      return globalThis.localStorage.getItem(DISMISS_KEY) === "1"
    } catch {
      return false
    }
  })()
  const [dismissed, setDismissed] = createSignal(stored)
  const [probe, { refetch }] = createResource(() => sdk.url, probeFda)
  const dialog = useDialog()

  const recheck = async () => {
    const r = await refetch()
    if (r?.fda) dialog.close()
  }

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1")
    } catch {}
    setDismissed(true)
  }

  const openSheet = () => {
    const os = detectOS()
    dialog.show(
      () => (
        <FdaSheet
          os={os}
          onRecheck={recheck}
          onDismiss={() => {
            dismiss()
            dialog.close()
          }}
        />
      ),
      () => {},
    )
  }

  return (
    <Show when={!dismissed() && !probe.loading && probe()?.fda === false}>
      <button
        type="button"
        class="folder-access-chip"
        onClick={openSheet}
        title={language.t("pages.surface.folderAccessBlocked")}
      >
        <span class="folder-access-chip__dot" aria-hidden="true" />
        {language.t("atlas.files.folderAccess")}
      </button>
    </Show>
  )
}

function FdaSheet(props: {
  os: "mac" | "win" | "linux"
  onRecheck: () => Promise<void>
  onDismiss: () => void
}): JSX.Element {
  const language = useLanguage()
  const url = () => SETTINGS_URL[props.os]
  const [busy, setBusy] = createSignal(false)
  return (
    <Dialog
      title={language.t("pages.surface.allowFolderAccess")}
      description={language.t(STEP_BODY[props.os])}
      class="folder-access-dialog"
      fit
      transition
    >
      <section class="folder-access-sheet" aria-label={language.t("pages.surface.folderAccessRecovery")}>
        <div class="folder-access-status">
          <span class="folder-access-status__dot" aria-hidden="true" />
          <span>
            <strong>{language.t("pages.surface.protectedFoldersUnavailable")}</strong>
            <small>{language.t("pages.surface.allowedFoldersHint")}</small>
          </span>
        </div>
        <Show when={props.os === "mac"}>
          <ol class="folder-access-steps">
            <li>
              <span>{language.t("pages.surface.privacyStep")}</span>
            </li>
            <li>
              <span>{language.t("pages.surface.enableAppStep")}</span>
            </li>
            <li>
              <span>{language.t("pages.surface.locateExecutable", { command: "which openscience" })}</span>
            </li>
            <li>
              <span>{language.t("pages.surface.relaunchStep")}</span>
            </li>
          </ol>
        </Show>
        <div class="folder-access-actions">
          <Show when={url()}>
            <a href={url()!} target="_self" class="folder-access-action folder-access-action--primary">
              <IconArrowRight size={12} strokeWidth={1.5} />
              {language.t("pages.surface.privacySettings")}
            </a>
          </Show>
          <button
            type="button"
            class="folder-access-action folder-access-action--secondary"
            onClick={async () => {
              setBusy(true)
              await props.onRecheck()
              setBusy(false)
            }}
            disabled={busy()}
          >
            <IconRefresh size={12} strokeWidth={1.5} />
            {busy() ? language.t("dialog.server.add.checking") : language.t("pages.surface.recheck")}
          </button>
          <button type="button" class="folder-access-action folder-access-action--dismiss" onClick={props.onDismiss}>
            {language.t("common.dismiss")}
          </button>
        </div>
      </section>
    </Dialog>
  )
}

// Backwards-compat: home.tsx still imports FdaBanner. Re-export the chip.
export const FdaBanner = FdaChip
