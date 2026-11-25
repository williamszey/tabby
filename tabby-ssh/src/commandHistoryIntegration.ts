export const commandHistoryOSC = 7777

export function commandHistoryInitialization (nonce: string): string {
    // PS0 runs before the command and PROMPT_COMMAND runs before the next prompt.
    // Bash history excludes input sent to programs and password prompts.
    return String.raw`if [ -n "${'$'}{BASH_VERSION-}" ] && (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then ` +
        String.raw`if ! declare -F __topper_recent_prompt >/dev/null; then ` +
        String.raw`__topper_recent_ps0=$PS0; __topper_recent_prompt() { ` +
        String.raw`local row command previous=$__topper_recent_last; row=$(HISTTIMEFORMAT= builtin history 1); ` +
        String.raw`if [[ $row =~ ^[[:blank:]]*([0-9]+)[[:blank:]]+(.*)$ ]] && [[ ${'$'}{BASH_REMATCH[1]} != "$__topper_recent_last" ]]; then ` +
        String.raw`__topper_recent_last=${'$'}{BASH_REMATCH[1]}; command=${'$'}{BASH_REMATCH[2]}; ` +
        String.raw`if [[ -n $previous && $command != *'__topper_recent_prompt'* && $command != *$'\n'* && ${'$'}{#command} -le 256 ]]; then ` +
        String.raw`builtin printf '\e]7777;topper;%s;command;%s\a' "$__topper_recent_nonce" "$(builtin printf '%s' "$command" | command base64 | command tr -d '\n')"; fi; fi; ` +
        String.raw`builtin printf '\e]7777;topper;%s;prompt\a' "$__topper_recent_nonce"; }; ` +
        String.raw`PROMPT_COMMAND+=(__topper_recent_prompt); fi; __topper_recent_nonce=${nonce}; ` +
        String.raw`PS0=$'\e]7777;topper;${nonce};busy\a'"${'$'}{__topper_recent_ps0}"; ` +
        String.raw`__topper_recent_last=; else printf '%s\n' 'TopperTerminal: Bash 5.1+ required'; fi`
}

export function looksLikeBashPrompt (line: string, user: string): boolean {
    const prompt = line.trimEnd()
    const prefix = user + '@'
    if (prompt.startsWith(prefix)) {
        return /^[\w.-]+:[^\r\n]+[#$]$/.test(prompt.slice(prefix.length))
    }
    if (prompt.startsWith('[' + prefix)) {
        return /^[\w.-]+ [^\r\n]+\][#$]$/.test(prompt.slice(prefix.length + 1))
    }
    return false
}
