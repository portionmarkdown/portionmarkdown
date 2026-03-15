<!-- classification
marking: UNCLASSIFIED
example: true
show-blocks: true
Classified by: EXAMPLE
Derived from: EXAMPLE
Declassify on: EXAMPLE
-->

<!-- cui
Controlled by: EXAMPLE
Categories: EXAMPLE
Distribution: EXAMPLE
POC: EXAMPLE
-->

<!-- markings
U: U | UNCLASSIFIED
CUI: CUI | CUI
S//NF: S//NF | SECRET//NOFORN
EXAMPLE: TS//ACCM-EXAMPLE | TOP SECRET//ACCM-EXAMPLE
-->

<div marking="U" markdown="1">

# portionmarkdown Example Output

---

</div>

<div marking="U" markdown="1">

```python
def hello():
    print("Example")
```

</div>

<div marking="CUI" markdown="1">

```python { startline=10 }
if __name__ == "__main__":
    hello()
```

</div>

<div marking="U" markdown="1">

## Example Table

</div>

<div marking="CUI" markdown="1">

Example paragraph for the table section.

| Column A | Column B | Column C |
|----------|----------|----------|
| Example  | This cell has a longer piece of text that should wrap to at least two rows in the rendered PDF output | Example  |
| Example  | Example  | Another cell with enough text to demonstrate multi-line wrapping behavior in a table |

</div>

<div marking="U" markdown="1">

## Example Link, Footnote & Line Break

See the [portionmarkdown repo](https://github.com/portionmarkdown/portionmarkdown)[^1] for documentation.

This line has a `<br>` line break<br>right here in the middle.

[^1]: (U) https://github.com/portionmarkdown/portionmarkdown

</div>

<div marking="U" markdown="1">

## Example Ordered List

</div>

<div marking="EXAMPLE" markdown="1">

1. Example step one
2. Example step two
3. Example step three

</div>

<div marking="U" markdown="1">

## Example Blockquote

> There is a `<pagebreak />` below this blockquote.

<pagebreak />

## Example Image

</div>

<div marking="U" markdown="1">

Example image at 100% width.

</div>

<div marking="S//NF" markdown="1">

![Example image](img/ChatGPT%20Image%20Mar%208,%202026,%2005_15_50%20PM.png){ width=100% }

</div>

<div marking="EXAMPLE" markdown="1">

Example image at 30% width.

![Example image](img/ChatGPT%20Image%20Mar%208,%202026,%2005_22_55%20PM.png){ width=30% }

</div>
