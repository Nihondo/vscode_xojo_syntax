#tag DesktopWindow
Begin DesktopWindow ExampleWindow
  Begin DesktopTabPanel Panel
  End
  Begin DesktopButton Button
    InitialParent = "pAnEl"
  End
  Begin DesktopButton Lost
    InitialParent = "Missing"
  End
  Begin DesktopButton CycleA
    InitialParent = "CycleB"
  End
  Begin DesktopButton CycleB
    InitialParent = "CycleA"
  End
End
#tag EndDesktopWindow
#tag WindowCode
  #tag Events bUtToN
    #tag Event
      Sub Pressed()
        If True Then
          Return
        End If
      End Sub
    #tag EndEvent
  #tag EndEvents
  #tag Event
    Sub Opening()
    End Sub
  #tag EndEvent
#tag EndWindowCode
