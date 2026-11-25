import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

interface Props {
  label: string;
  /** The name under which a form sends the choice. */
  name: string;
  /** The tenants to choose from. Empty until the API has named them. */
  options: string[];
}

/**
 * A list to choose one tenant from, drawn by the page instead of the browser.
 * It follows the "select only combobox" of the WAI-ARIA guide: the focus stays
 * on the box, the arrow keys move through the open list, Enter or Space
 * chooses, Escape closes, a letter jumps to the next tenant that starts with
 * it. The choice goes to the form through a hidden input.
 */
export function TenantPicker({ label, name, options }: Props) {
  const id = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // The option the arrow keys are on while the list is open.
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  // Until someone chooses, the first tenant is the choice. So is it when the
  // chosen tenant is no longer in the list.
  const value =
    chosen !== null && options.includes(chosen) ? chosen : (options[0] ?? "");
  const disabled = options.length === 0;

  // A long list scrolls so the option the keys are on stays in view.
  useEffect(() => {
    if (!open) return;
    list.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  function show() {
    setActive(Math.max(0, options.indexOf(value)));
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (option !== undefined) setChosen(option);
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (disabled) return;
    const last = options.length - 1;
    const keys: Record<string, () => void> = open
      ? {
          ArrowDown: () => setActive((i) => Math.min(last, i + 1)),
          ArrowUp: () => setActive((i) => Math.max(0, i - 1)),
          Home: () => setActive(0),
          End: () => setActive(last),
          Enter: () => choose(active),
          " ": () => choose(active),
          Escape: () => setOpen(false),
        }
      : { ArrowDown: show, ArrowUp: show, Enter: show, " ": show };
    const action = keys[event.key];
    if (action) {
      event.preventDefault();
      action();
    } else if (event.key.length === 1 && event.key.trim()) {
      jumpTo(event.key.toLowerCase());
    }
  }

  /** Moves to the next tenant after the current one that starts with `letter`. */
  function jumpTo(letter: string) {
    const from = open ? active : options.indexOf(value);
    const order = [...options.keys()].map(
      (step) => (from + 1 + step) % options.length,
    );
    const next = order.find((index) => options[index]?.startsWith(letter));
    if (next === undefined) return;
    if (open) setActive(next);
    else setChosen(options[next] ?? null);
  }

  return (
    <div className="picker">
      <span id={`${id}-label`}>{label}</span>
      <div
        role="combobox"
        className="picker-box"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={`${id}-label`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (disabled) return;
          if (open) setOpen(false);
          else show();
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      >
        {disabled ? "..." : value}
      </div>
      {open && (
        <ul
          ref={list}
          id={`${id}-list`}
          role="listbox"
          className="picker-list"
          aria-labelledby={`${id}-label`}
        >
          {options.map((option, index) => (
            <li
              key={option}
              id={`${id}-${index}`}
              role="option"
              aria-selected={option === value}
              data-index={index}
              className={
                index === active ? "picker-option active" : "picker-option"
              }
              // Keeps the focus on the box, so the list does not close first.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(index)}
            >
              {option}
            </li>
          ))}
        </ul>
      )}
      <input type="hidden" name={name} value={value} />
    </div>
  );
}
